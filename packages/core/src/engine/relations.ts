import { Predicate } from "effect";
import { errorDiagnostic, type Diagnostic } from "../diagnostics";
import { writePath, type DocumentFields, type FieldPath } from "../document";
import type { ReferenceFieldSpec } from "../plugin/types";
import { walkData, type DataOccurrence } from "../schema/walk";
import type { ResolvedProject, ResolvedSource } from "./resolve";
import type {
  FinalDocument,
  SourceDocuments,
  SourceFile,
  ValidatedDocument,
} from "./types";

type LookupIndex = Map<string, Map<string, FinalDocument[]>>;

type Lookup =
  | { readonly ok: true; readonly target: FinalDocument }
  | { readonly ok: false; readonly message: string; readonly hint: string };

type ReferenceOccurrence = DataOccurrence & {
  readonly spec: ReferenceFieldSpec;
  readonly value: string;
};

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

function stringReferences(
  occurrences: readonly DataOccurrence[],
): ReferenceOccurrence[] {
  return occurrences.filter(
    (occurrence): occurrence is ReferenceOccurrence =>
      occurrence.spec.type === "reference" &&
      Predicate.isString(occurrence.value),
  );
}

function pathKey(path: FieldPath): string {
  return JSON.stringify(path);
}

/**
 * Check every `s.reference()` value and replace `embed: true` values with
 * the final target document. Sources are processed so embed targets are
 * complete before they are embedded. Every failure is reported.
 *
 * Two passes per document, both following the schema (only the union
 * variant the data selects, recursive schemas to any depth):
 *
 * - the schema-validated data (`validated`, before `transform`): every
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
 * Without `validated` data for a document, only the final data is checked.
 */
export function resolveRelations(
  project: ResolvedProject,
  sources: readonly SourceDocuments<FinalDocument>[],
  validated: readonly ValidatedDocument[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byName = new Map(sources.map((group) => [group.source.name, group]));
  const schemaData = new Map<SourceFile, DocumentFields>(
    validated.map((document) => [document.file, document.data]),
  );
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

  for (const group of ordered) {
    const source: ResolvedSource = group.source;
    if (source.references.length === 0) continue;
    const schema = source.definition.schema;
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

      const validatedData = schemaData.get(document.file);
      const checked = new Map<string, { value: string; result: Lookup }>();
      if (validatedData !== undefined) {
        const walk = walkData(schema, validatedData);
        reportTooDeep(walk.tooDeep);
        for (const occurrence of stringReferences(walk.occurrences)) {
          const result = lookup(document, occurrence.spec, occurrence.value);
          if (!result) continue;
          checked.set(pathKey(occurrence.path), {
            value: occurrence.value,
            result,
          });
          if (!result.ok) report(occurrence.path, result.message, result.hint);
        }
      }

      const finalWalk = walkData(schema, document.data);
      if (validatedData === undefined) reportTooDeep(finalWalk.tooDeep);
      for (const occurrence of stringReferences(finalWalk.occurrences)) {
        const previous = checked.get(pathKey(occurrence.path));
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
          writePath(document.data, occurrence.path, {
            ...result.target.data,
            _meta: result.target.file.meta,
          });
        }
      }
    }
  }
  return diagnostics;
}
