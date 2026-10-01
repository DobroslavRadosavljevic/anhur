import { Predicate } from "effect";
import type {
  AnyContent,
  TransformDocument,
  ViewContext,
} from "../define/types";
import { errorDiagnostic, messageOf, type Diagnostic } from "../diagnostics";
import { isPlainObject, type DocumentFields } from "../document";
import { toExport, toListRow } from "./list-rows";
import type { ResolvedDerived } from "./resolve";
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
 */
export function deriveAll(
  derivedList: readonly ResolvedDerived[],
  sources: readonly SourceDocuments<FinalDocument>[],
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
  const context: ViewContext = {
    documents: (source: AnyContent | string) => {
      const name = Predicate.isString(source) ? source : source.name;
      if (!byName.has(name)) {
        throw new Error(
          `ctx.documents("${name}"): no such collection or singleton.`,
        );
      }
      return [...documentsOf(name)];
    },
  };

  const results: DerivedResult[] = [];
  for (const derived of derivedList) {
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
        }),
      );
    };
    const multi = derived.from.length > 1;
    const rows: Row[] = [];
    let failed = false;
    for (const collection of derived.from) {
      const group = byName.get(collection.name);
      if (!group) continue;
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

    if (derived.kind === "view") {
      results.push({
        kind: "view",
        derived,
        items: finalize(
          rows.map((entry) => entry.row),
          derived,
        ),
      });
      continue;
    }
    if (derived.kind === "index") {
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
      results.push({
        kind: "index",
        derived,
        entries: ordered.map((row) => [keyed.get(row)!, row] as const),
      });
      continue;
    }
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
    results.push({ kind: "group", derived, groups });
  }
  return { results, diagnostics };
}
