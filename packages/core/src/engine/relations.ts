import { Predicate } from "effect";
import type { z } from "zod";
import { errorDiagnostic, type Diagnostic } from "../diagnostics";
import {
  isPlainObject,
  setField,
  type DocumentFields,
  type DocumentValue,
  type FieldPath,
} from "../document";
import type { ReferenceFieldSpec } from "../plugin/types";
import { walkData } from "../schema/walk";
import { deepFreeze, isDeepFrozen } from "./freeze";
import { toExport } from "./list-rows";
import type { ResolvedProject, ResolvedSource } from "./resolve";
import { sameItems } from "./same-items";
import type { FinalDocument, SourceDocuments } from "./types";

type LookupIndex = Map<string, Map<string, FinalDocument[]>>;

type Lookup =
  | { readonly ok: true; readonly target: FinalDocument }
  | { readonly ok: false; readonly message: string; readonly hint: string };

type ReferenceOccurrence = {
  readonly path: FieldPath;
  readonly spec: ReferenceFieldSpec;
  readonly value: string;
};

/** String values at the reference locations of one data object. */
type ReferenceWalk = {
  readonly schema: z.core.$ZodType;
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly tooDeep: FieldPath | undefined;
};

/**
 * Document data is frozen, so the references in it are found once and
 * remembered for as long as the data object lives.
 */
const referenceWalks = new WeakMap<DocumentFields, ReferenceWalk>();

function referencesIn(
  schema: z.core.$ZodType,
  data: DocumentFields,
): ReferenceWalk {
  const known = referenceWalks.get(data);
  if (known && known.schema === schema) return known;
  const walk = walkData(schema, data);
  const occurrences: ReferenceOccurrence[] = [];
  for (const occurrence of walk.occurrences) {
    if (
      occurrence.spec.type === "reference" &&
      Predicate.isString(occurrence.value)
    ) {
      occurrences.push({
        path: occurrence.path,
        spec: occurrence.spec,
        value: occurrence.value,
      });
    }
  }
  const result: ReferenceWalk = { schema, occurrences, tooDeep: walk.tooDeep };
  // Only deep-frozen data is known to stay as it is.
  if (isDeepFrozen(data)) referenceWalks.set(data, result);
  return result;
}

/** A document with its embeds resolved, and the targets that were embedded. */
type EmbedRecord = {
  readonly targets: readonly FinalDocument[];
  readonly result: FinalDocument;
};

/**
 * What a session remembers about embeds between builds: the embedded form
 * of a document is reused while the document and every document embedded
 * in it stay the same.
 */
export type RelationMemory = {
  readonly embeds: WeakMap<FinalDocument, EmbedRecord>;
  /** Sources whose references were all fine, with what was checked. */
  readonly groups: Map<string, GroupRecord>;
};

/**
 * A source whose references resolved without a problem. While its
 * documents and the documents of every source it refers to are the same,
 * the outcome is the same.
 */
type GroupRecord = {
  readonly documents: readonly FinalDocument[];
  /** Documents of each referenced source, as they were looked up. */
  readonly targets: ReadonlyMap<string, readonly FinalDocument[]>;
  /** The documents with their embeds (`documents` itself without embeds). */
  readonly result: FinalDocument[];
};

export function createRelationMemory(): RelationMemory {
  return { embeds: new WeakMap(), groups: new Map() };
}

function lookupValue(document: FinalDocument, by: string): string | undefined {
  if (by === "id") return document.file.id;
  const value = document.data[by];
  return Predicate.isString(value) && value.length > 0 ? value : undefined;
}

/** Index of a source's documents by locale (`""` for monolingual) and key. */
function buildIndex(
  documents: readonly FinalDocument[],
  by: string,
): LookupIndex {
  const index: LookupIndex = new Map();
  for (const document of documents) {
    const key = lookupValue(document, by);
    if (key === undefined) continue;
    const locale = document.file.locale ?? "";
    let byKey = index.get(locale);
    if (!byKey) {
      byKey = new Map();
      index.set(locale, byKey);
    }
    const list = byKey.get(key);
    if (list) list.push(document);
    else byKey.set(key, [document]);
  }
  return index;
}

function pathKey(path: FieldPath): string {
  return JSON.stringify(path);
}

/**
 * Copy of `root` with `value` at `path`. Only the containers on the path
 * are copied (each once: `fresh` holds the copies made so far), everything
 * else is shared with `root`. Returns `root` when a container on the path
 * is missing.
 */
function withValueAt(
  root: DocumentFields,
  path: FieldPath,
  value: DocumentValue,
  fresh: Set<object>,
): DocumentFields {
  if (path.length === 0) return root;
  const copyOf = <T extends DocumentFields | DocumentValue[]>(
    container: T,
  ): T => {
    if (fresh.has(container)) return container;
    // SAFETY: an array copy of an array, an object copy of a plain object.
    const copy = (
      Array.isArray(container) ? [...container] : { ...container }
    ) as T;
    fresh.add(copy);
    return copy;
  };
  const result = copyOf(root);
  let current: DocumentFields | DocumentValue[] = result;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    const last = index === path.length - 1;
    let child: DocumentValue;
    if (Array.isArray(current)) {
      if (!Predicate.isNumber(segment)) return root;
      child = current[segment];
    } else {
      if (!Predicate.isString(segment) || !Object.hasOwn(current, segment)) {
        return root;
      }
      child = current[segment];
    }
    let next: DocumentValue;
    if (last) next = value;
    else if (Array.isArray(child)) {
      const items: DocumentValue[] = child;
      next = copyOf(items);
    } else if (isPlainObject(child)) next = copyOf(child);
    else return root;
    if (Array.isArray(current)) {
      if (Predicate.isNumber(segment)) current[segment] = next;
    } else if (Predicate.isString(segment)) setField(current, segment, next);
    if (!last && (Array.isArray(next) || isPlainObject(next))) {
      // SAFETY: `next` is the copy made above: an array or a plain object.
      current = next as DocumentFields | DocumentValue[];
    }
  }
  return result;
}

/**
 * Check every `s.reference()` value and replace `embed: true` values with
 * the final target document. Sources are processed so embed targets are
 * complete before they are embedded. Every failure is reported.
 *
 * Two passes per document, both following the schema (only the union
 * variant the data selects, recursive schemas to any depth):
 *
 * - the schema-validated data (`origin`, before `transform`): every
 *   reference the file sets must exist, even when the transform renames or
 *   drops the field;
 * - the final data: a string still found at a reference location (or set
 *   there by the transform) is checked too, and embedded when `embed` is
 *   on. This is the rule the generated types follow.
 *
 * Targets are the final documents (after transforms, drafts and skips).
 * A localized target is searched in the referrer's locale (the default
 * locale when the referrer is monolingual); a monolingual target in its
 * only set. Duplicate keys in the same scope are reported as ambiguous.
 *
 * Documents are never changed in place: a document with embeds is replaced
 * in its group by a new one (its data shares everything but the embedded
 * values with the original). Without an `origin`, only the final data is
 * checked.
 */
export function resolveRelations(
  project: ResolvedProject,
  sources: readonly SourceDocuments<FinalDocument>[],
  memory: RelationMemory = createRelationMemory(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byName = new Map(sources.map((group) => [group.source.name, group]));
  const indexes = new Map<string, LookupIndex>();
  const indexFor = (target: SourceDocuments<FinalDocument>, by: string) => {
    const key = `${target.source.name}\u0000${by}`;
    let index = indexes.get(key);
    if (!index) {
      index = buildIndex(target.documents, by);
      indexes.set(key, index);
    }
    return index;
  };

  const lookup = (
    document: FinalDocument,
    spec: ReferenceFieldSpec,
    value: string,
  ): Lookup | undefined => {
    const target = byName.get(spec.collection);
    if (!target) return undefined;
    const locale = target.source.localized
      ? (document.file.locale ?? project.localization?.defaultLocale ?? "")
      : "";
    const candidates = indexFor(target, spec.by).get(locale)?.get(value) ?? [];
    if (candidates.length === 0) {
      const scope = target.source.localized ? ` in locale "${locale}"` : "";
      return {
        ok: false,
        message: `No ${target.source.name} document with ${spec.by} "${value}"${scope}.`,
        hint: "Fix the value, or make sure the target is not a draft or skipped by its transform.",
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        message: `${candidates.length} ${target.source.name} documents have ${spec.by} "${value}": ${candidates.map((candidate) => candidate.file.meta.filePath).join(", ")}.`,
        hint: `Make ${spec.by} unique or reference by id.`,
      };
    }
    return { ok: true, target: candidates[0]! };
  };

  const ordered = project.embedOrder
    .map((name) => byName.get(name))
    .filter(
      (group): group is SourceDocuments<FinalDocument> => group !== undefined,
    );

  const names = new Set(ordered.map((group) => group.source.name));
  for (const name of memory.groups.keys()) {
    if (!names.has(name)) memory.groups.delete(name);
  }
  /** Use the documents with embeds of a source from here on. */
  const replace = (
    group: SourceDocuments<FinalDocument>,
    documents: FinalDocument[],
  ): void => {
    group.documents = documents;
    // Later lookups must find the documents with their embeds.
    for (const key of indexes.keys()) {
      if (key.startsWith(`${group.source.name}\u0000`)) indexes.delete(key);
    }
  };

  for (const group of ordered) {
    const source: ResolvedSource = group.source;
    if (source.references.length === 0) continue;
    const schema = source.definition.schema;
    const targetNames = new Set(
      source.references.map((reference) => reference.spec.collection),
    );
    const known = memory.groups.get(source.name);
    if (known && sameItems(known.documents, group.documents)) {
      let unchanged = true;
      for (const [name, documents] of known.targets) {
        const target = byName.get(name);
        if (!target || !sameItems(target.documents, documents)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged && known.targets.size === targetNames.size) {
        if (known.result !== group.documents) replace(group, known.result);
        continue;
      }
    }
    const before = diagnostics.length;
    const input = group.documents;
    // A source may refer to itself: remember its documents as looked up.
    const targets = new Map<string, readonly FinalDocument[]>();
    for (const name of targetNames) {
      const target = byName.get(name);
      if (target) targets.set(name, [...target.documents]);
    }
    const next: FinalDocument[] = [];
    let replaced = false;
    for (const document of group.documents) {
      const report = (
        fieldPath: FieldPath,
        message: string,
        hint: string,
      ): void => {
        diagnostics.push(
          errorDiagnostic("reference-failed", message, {
            file: document.file.absPath,
            source: source.name,
            fieldPath,
            hint,
          }),
        );
      };
      const reportTooDeep = (fieldPath: FieldPath | undefined): void => {
        if (fieldPath === undefined) return;
        report(
          fieldPath,
          "The data nests too deeply to check the references inside it.",
          "Flatten the data structure.",
        );
      };

      const validatedData = document.origin?.data;
      const finalWalk = referencesIn(schema, document.data);
      let checked: Map<string, { value: string; result: Lookup }> | undefined;
      if (validatedData !== undefined) {
        // Without a transform the final data is the validated data: one pass.
        const walk =
          validatedData === document.data
            ? finalWalk
            : referencesIn(schema, validatedData);
        reportTooDeep(walk.tooDeep);
        for (const occurrence of walk.occurrences) {
          const result = lookup(document, occurrence.spec, occurrence.value);
          if (!result) continue;
          checked ??= new Map();
          checked.set(pathKey(occurrence.path), {
            value: occurrence.value,
            result,
          });
          if (!result.ok) report(occurrence.path, result.message, result.hint);
        }
      } else {
        reportTooDeep(finalWalk.tooDeep);
      }

      const embeds: { path: FieldPath; target: FinalDocument }[] = [];
      for (const occurrence of finalWalk.occurrences) {
        const previous = checked?.get(pathKey(occurrence.path));
        let result: Lookup | undefined;
        if (previous && previous.value === occurrence.value) {
          result = previous.result;
        } else {
          result = lookup(document, occurrence.spec, occurrence.value);
          if (result && !result.ok) {
            report(
              occurrence.path,
              result.message,
              validatedData === undefined
                ? result.hint
                : `The transform set this value. ${result.hint}`,
            );
          }
        }
        if (result?.ok && occurrence.spec.embed) {
          embeds.push({ path: occurrence.path, target: result.target });
        }
      }
      if (embeds.length === 0) {
        next.push(document);
        continue;
      }
      replaced = true;
      const embedded = embeds.map((embed) => embed.target);
      const record = memory.embeds.get(document);
      if (record && sameItems(record.targets, embedded)) {
        next.push(record.result);
        continue;
      }
      const fresh = new Set<object>();
      let data = document.data;
      for (const embed of embeds) {
        data = withValueAt(data, embed.path, toExport(embed.target), fresh);
      }
      const result: FinalDocument = {
        file: document.file,
        data: deepFreeze(data),
        effects: document.effects,
        origin: document.origin,
      };
      memory.embeds.set(document, { targets: embedded, result });
      next.push(result);
    }
    if (replaced) replace(group, next);
    if (diagnostics.length === before && targets.size === targetNames.size) {
      memory.groups.set(source.name, {
        documents: [...input],
        targets,
        result: group.documents,
      });
    } else {
      memory.groups.delete(source.name);
    }
  }
  return diagnostics;
}
