import { Predicate } from "effect";
import { errorDiagnostic, type Diagnostic } from "../diagnostics";
import { formatFieldPath, type DocumentValue } from "../document";
import type { FieldSpec, UniqueOptions } from "../plugin/types";
import { walkData } from "../schema/walk";
import type { FinalDocument, SourceDocuments } from "./types";

type Owner = {
  readonly document: FinalDocument;
  readonly path: string;
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
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const owners = new Map<string, Owner>();
  for (const group of sources) {
    if (group.source.uniques.length === 0) continue;
    const schema = group.source.definition.schema;
    for (const document of group.documents) {
      const walk = walkData(schema, document.data);
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
        const options = uniqueOptions(occurrence.spec);
        if (!options) continue;
        const value = occurrence.value;
        const key = valueKey(value);
        if (key === undefined) continue;
        const scope =
          options.scope ?? (group.source.localized ? "locale" : "collection");
        const groupName = options.group ?? occurrence.field;
        const bucket =
          scope === "project"
            ? `project\u0000${groupName}`
            : `${group.source.name}\u0000${groupName}`;
        const locale = scope === "locale" ? (document.file.locale ?? "") : "";
        const ownerKey = `${bucket}\u0000${locale}\u0000${key}`;
        const path = formatFieldPath(occurrence.path);
        const owner = owners.get(ownerKey);
        if (!owner) {
          owners.set(ownerKey, { document, path });
          continue;
        }
        if (owner.document === document && owner.path === path) continue;
        diagnostics.push(
          errorDiagnostic(
            "unique-conflict",
            `Duplicate ${occurrence.field} "${String(value)}": already used by ${owner.document.file.meta.filePath}${owner.path !== path ? ` (${owner.path})` : ""}.`,
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
