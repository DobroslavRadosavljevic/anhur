import { Predicate } from "effect";
import type {
  AnyContent,
  TransformDocument,
  ViewContext,
} from "../define/types";
import { errorDiagnostic, messageOf, type Diagnostic } from "../diagnostics";
import { isPlainObject, type DocumentFields } from "../document";
import { frozenWriteHint } from "./freeze";
import { toExport, toListRow } from "./list-rows";
import type { ResolvedDerived } from "./resolve";
import { sameItems } from "./same-items";
import { compareKeys, sortRows } from "./sort";
import type { FinalDocument, SourceDocuments } from "./types";

export type DerivedGroup = {
  readonly key: string;
  readonly count: number;
  readonly items: DocumentFields[];
};

export type DerivedResult =
  | {
      readonly kind: "view";
      readonly derived: ResolvedDerived;
      readonly items: DocumentFields[];
    }
  | {
      readonly kind: "index";
      readonly derived: ResolvedDerived;
      /** Key → item, in output order. */
      readonly entries: readonly (readonly [string, DocumentFields])[];
    }
  | {
      readonly kind: "group";
      readonly derived: ResolvedDerived;
      readonly groups: DerivedGroup[];
    };

export type DeriveOutcome = {
  readonly results: DerivedResult[];
  readonly diagnostics: Diagnostic[];
};

/** A resolved view / index / group and the documents it was made from. */
type DerivedRecord = {
  readonly derived: ResolvedDerived;
  /** Documents of every source it is `from` or read through `ctx.documents()`. */
  readonly inputs: ReadonlyMap<string, readonly FinalDocument[]>;
  readonly result: DerivedResult;
};

/**
 * What a session remembers about views between builds: a view, index or
 * group is resolved again only when a source it uses has other documents.
 */
export type DeriveMemory = {
  readonly records: Map<string, DerivedRecord>;
};

export function createDeriveMemory(): DeriveMemory {
  return { records: new Map() };
}

type Row = {
  readonly document: FinalDocument;
  readonly key: string | undefined;
  readonly row: DocumentFields;
};

function finalize(
  rows: DocumentFields[],
  derived: ResolvedDerived,
): DocumentFields[] {
  const compare = derived.definition.generate?.compare;
  let sorted = compare
    ? [...rows].sort(compare)
    : sortRows(rows, derived.listSort);
  if (derived.limit !== undefined) sorted = sorted.slice(0, derived.limit);
  return sorted;
}

/**
 * Resolve views, indexes and groups from final documents. User callbacks
 * that throw, invalid keys and duplicate index keys become diagnostics.
 *
 * With a `memory`, the result of an earlier build is returned as is (the
 * same object) while every source the view uses has the same documents.
 */
export function deriveAll(
  derivedList: readonly ResolvedDerived[],
  sources: readonly SourceDocuments<FinalDocument>[],
  memory: DeriveMemory = createDeriveMemory(),
): DeriveOutcome {
  const diagnostics: Diagnostic[] = [];
  const byName = new Map(sources.map((group) => [group.source.name, group]));
  const exported = new Map<string, TransformDocument[]>();
  const documentsOf = (name: string): TransformDocument[] => {
    let list = exported.get(name);
    if (!list) {
      list = (byName.get(name)?.documents ?? []).map(toExport);
      exported.set(name, list);
    }
    return list;
  };
  const current = new Set(derivedList.map((derived) => derived.name));
  for (const name of memory.records.keys()) {
    if (!current.has(name)) memory.records.delete(name);
  }

  const results: DerivedResult[] = [];
  for (const derived of derivedList) {
    const remember = derived.definition.generate?.cache !== false;
    const known = remember ? memory.records.get(derived.name) : undefined;
    if (known && known.derived === derived) {
      let unchanged = true;
      for (const [name, documents] of known.inputs) {
        const group = byName.get(name);
        if (!group || !sameItems(group.documents, documents)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        results.push(known.result);
        continue;
      }
    }
    const inputs = new Map<string, readonly FinalDocument[]>();
    const use = (name: string): void => {
      if (inputs.has(name)) return;
      const group = byName.get(name);
      if (group) inputs.set(name, [...group.documents]);
    };
    const context: ViewContext = {
      documents: (source: AnyContent | string) => {
        const name = Predicate.isString(source) ? source : source.name;
        if (!byName.has(name)) {
          throw new Error(
            `ctx.documents("${name}"): no such collection or singleton.`,
          );
        }
        use(name);
        return [...documentsOf(name)];
      },
    };
    const definition = derived.definition;
    const label = `${derived.kind} "${derived.name}"`;
    const fail = (
      document: FinalDocument | undefined,
      message: string,
      cause?: unknown,
    ) => {
      diagnostics.push(
        errorDiagnostic("derive-failed", `${label}: ${message}`, {
          source: derived.name,
          file: document?.file.absPath,
          cause,
          hint: frozenWriteHint(cause),
        }),
      );
    };
    const multi = derived.from.length > 1;
    const rows: Row[] = [];
    let failed = false;
    for (const collection of derived.from) {
      const group = byName.get(collection.name);
      if (!group) continue;
      use(collection.name);
      const omit = derived.listOmit ?? collection.generate.listOmit;
      for (const document of group.documents) {
        const full = toExport(document);
        const input: TransformDocument = multi
          ? { ...full, collection: collection.name }
          : full;
        try {
          if (definition.where && !definition.where(input, context)) continue;
          let key: string | undefined;
          if (definition.type !== "view") {
            const keySpec =
              definition.type === "index" ? definition.key : definition.by;
            const value = Predicate.isFunction(keySpec)
              ? keySpec(input)
              : input[keySpec];
            if (!Predicate.isString(value) || value.length === 0) {
              fail(
                document,
                Predicate.isFunction(keySpec)
                  ? "the key function must return a non-empty string."
                  : `field "${keySpec}" must be a non-empty string on every document (it is ${value === undefined ? "missing" : JSON.stringify(value)}).`,
              );
              failed = true;
              continue;
            }
            key = value;
          }
          let row: DocumentFields;
          if (definition.select) {
            const selected = definition.select(input, context);
            if (!isPlainObject(selected)) {
              fail(document, "select() must return a plain object.");
              failed = true;
              continue;
            }
            row = selected;
          } else {
            row = toListRow(document, omit);
            if (multi) row = { ...row, collection: collection.name };
          }
          rows.push({ document, key, row });
        } catch (cause) {
          fail(document, `a callback threw: ${messageOf(cause)}`, cause);
          failed = true;
        }
      }
    }
    if (failed) continue;

    let result: DerivedResult;
    if (derived.kind === "view") {
      result = {
        kind: "view",
        derived,
        items: finalize(
          rows.map((entry) => entry.row),
          derived,
        ),
      };
    } else if (derived.kind === "index") {
      const owners = new Map<string, FinalDocument>();
      const keyed = new Map<DocumentFields, string>();
      for (const entry of rows) {
        const key = entry.key!;
        const owner = owners.get(key);
        if (owner) {
          fail(
            entry.document,
            `key "${key}" is used by ${owner.file.meta.filePath} and ${entry.document.file.meta.filePath}.`,
          );
          failed = true;
          continue;
        }
        owners.set(key, entry.document);
      }
      if (failed) continue;
      // One object per row: select() may return the same object for several
      // documents, and rows are matched back to their keys by identity.
      const own = rows.map((entry) => {
        const row = { ...entry.row };
        keyed.set(row, entry.key!);
        return row;
      });
      const ordered = finalize(own, derived);
      result = {
        kind: "index",
        derived,
        entries: ordered.map((row) => [keyed.get(row)!, row] as const),
      };
    } else {
      const buckets = new Map<string, DocumentFields[]>();
      for (const entry of rows) {
        const list = buckets.get(entry.key!);
        if (list) list.push(entry.row);
        else buckets.set(entry.key!, [entry.row]);
      }
      const groups = [...buckets.keys()].sort(compareKeys).map((key) => {
        const bucket = buckets.get(key)!;
        return { key, count: bucket.length, items: finalize(bucket, derived) };
      });
      result = { kind: "group", derived, groups };
    }
    results.push(result);
    if (remember) memory.records.set(derived.name, { derived, inputs, result });
  }
  return { results, diagnostics };
}
