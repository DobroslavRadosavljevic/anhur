import { Predicate } from "effect";
import type { z } from "zod";
import { errorDiagnostic, type Diagnostic } from "../diagnostics";
import {
  formatFieldPath,
  type DocumentFields,
  type DocumentValue,
  type FieldPath,
} from "../document";
import type { FieldSpec, UniqueOptions } from "../plugin/types";
import { walkData } from "../schema/walk";
import type { FinalDocument, SourceDocuments } from "./types";

type Owner = {
  readonly document: FinalDocument;
  readonly path: FieldPath;
};

function uniqueOptions(spec: FieldSpec): UniqueOptions | undefined {
  if (spec.type === "unique") return spec.options;
  if (spec.type === "compile") return spec.unique;
  return undefined;
}

/** `1` and `"1"` are different values. */
function valueKey(value: DocumentValue): string | undefined {
  if (Predicate.isString(value)) return `s:${value}`;
  if (Predicate.isNumber(value)) return `n:${String(value)}`;
  return undefined;
}

/** A unique value of one document. */
type UniqueOccurrence = {
  readonly path: FieldPath;
  /** Static location (`tags[].ref`). */
  readonly field: string;
  readonly options: UniqueOptions;
  readonly value: DocumentValue;
  readonly key: string;
};

type UniqueWalk = {
  readonly schema: z.core.$ZodType;
  readonly occurrences: readonly UniqueOccurrence[];
  readonly tooDeep: FieldPath | undefined;
};

/**
 * Document data is frozen, so its unique values are found once and
 * remembered for as long as the data object lives.
 */
const uniqueWalks = new WeakMap<DocumentFields, UniqueWalk>();

function uniquesIn(schema: z.core.$ZodType, data: DocumentFields): UniqueWalk {
  const known = uniqueWalks.get(data);
  if (known && known.schema === schema) return known;
  const walk = walkData(schema, data);
  const occurrences: UniqueOccurrence[] = [];
  for (const occurrence of walk.occurrences) {
    const options = uniqueOptions(occurrence.spec);
    if (!options) continue;
    const key = valueKey(occurrence.value);
    if (key === undefined) continue;
    occurrences.push({
      path: occurrence.path,
      field: occurrence.field,
      options,
      value: occurrence.value,
      key,
    });
  }
  const result: UniqueWalk = { schema, occurrences, tooDeep: walk.tooDeep };
  // Only frozen data is known to stay as it is.
  if (Object.isFrozen(data)) uniqueWalks.set(data, result);
  return result;
}

/**
 * What a session remembers about uniqueness between builds: the documents
 * of the last check that found no conflict. The same documents cannot
 * conflict now.
 */
export type UniqueMemory = {
  passed: ReadonlyMap<string, readonly FinalDocument[]> | undefined;
};

export function createUniqueMemory(): UniqueMemory {
  return { passed: undefined };
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Enforce `s.unique()` (and `s.slug()`) on the documents that are part of
 * the output, at the locations the schema gives them (only the union
 * variant a document selects; recursive schemas to any depth). Values are
 * grouped by field location unless a `group` is set, so two unique fields
 * never conflict with each other, and one document never conflicts with
 * itself at the same path.
 *
 * Scopes: `locale` (default for localized sources), `collection`, `project`.
 */
export function checkUniqueness(
  sources: readonly SourceDocuments<FinalDocument>[],
  memory: UniqueMemory = createUniqueMemory(),
): Diagnostic[] {
  const checked = sources.filter((group) => group.source.uniques.length > 0);
  const passed = memory.passed;
  if (
    passed &&
    passed.size === checked.length &&
    checked.every((group) => {
      const documents = passed.get(group.source.name);
      return documents !== undefined && sameItems(documents, group.documents);
    })
  ) {
    return [];
  }
  const diagnostics = findConflicts(checked);
  memory.passed =
    diagnostics.length === 0
      ? new Map(
          checked.map((group) => [group.source.name, [...group.documents]]),
        )
      : undefined;
  return diagnostics;
}

function findConflicts(
  sources: readonly SourceDocuments<FinalDocument>[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const owners = new Map<string, Owner>();
  for (const group of sources) {
    if (group.source.uniques.length === 0) continue;
    const schema = group.source.definition.schema;
    for (const document of group.documents) {
      const walk = uniquesIn(schema, document.data);
      if (walk.tooDeep !== undefined) {
        diagnostics.push(
          errorDiagnostic(
            "unique-conflict",
            "The data nests too deeply to check the unique fields inside it.",
            {
              file: document.file.absPath,
              source: group.source.name,
              fieldPath: walk.tooDeep,
              hint: "Flatten the data structure.",
            },
          ),
        );
      }
      for (const occurrence of walk.occurrences) {
        const { options, value } = occurrence;
        const scope =
          options.scope ?? (group.source.localized ? "locale" : "collection");
        const groupName = options.group ?? occurrence.field;
        const bucket =
          scope === "project"
            ? `project\u0000${groupName}`
            : `${group.source.name}\u0000${groupName}`;
        const locale = scope === "locale" ? (document.file.locale ?? "") : "";
        const ownerKey = `${bucket}\u0000${locale}\u0000${occurrence.key}`;
        const owner = owners.get(ownerKey);
        if (!owner) {
          owners.set(ownerKey, { document, path: occurrence.path });
          continue;
        }
        const path = formatFieldPath(occurrence.path);
        const ownerPath = formatFieldPath(owner.path);
        if (owner.document === document && ownerPath === path) continue;
        diagnostics.push(
          errorDiagnostic(
            "unique-conflict",
            `Duplicate ${occurrence.field} "${String(value)}": already used by ${owner.document.file.meta.filePath}${ownerPath !== path ? ` (${ownerPath})` : ""}.`,
            {
              file: document.file.absPath,
              source: group.source.name,
              fieldPath: occurrence.path,
              hint:
                scope === "locale"
                  ? "Values must be unique per locale."
                  : scope === "collection"
                    ? "Values must be unique in this collection."
                    : "Values must be unique across the project group.",
            },
          ),
        );
      }
    }
  }
  return diagnostics;
}
