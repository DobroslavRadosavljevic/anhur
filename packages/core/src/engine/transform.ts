import { Effect, Predicate } from "effect";
import { createSkippedSignal, isSkippedSignal } from "../define/content";
import type {
  AnyContent,
  TransformContext,
  TransformDocument,
} from "../define/types";
import { errorDiagnostic, messageOf, type Diagnostic } from "../diagnostics";
import { isPlainObject, type DocumentFields } from "../document";
import { deepFreeze } from "./freeze";
import { findNonPlainData } from "./plain-data";
import type { ResolvedProject } from "./resolve";
import type {
  FinalDocument,
  SourceDocuments,
  ValidatedDocument,
} from "./types";

const TRANSFORM_TIMEOUT = "5 minutes";

export type TransformResult = {
  readonly sources: SourceDocuments<FinalDocument>[];
  readonly diagnostics: readonly Diagnostic[];
};

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (Predicate.isString(value)) return "a string";
  if (Predicate.isNumber(value)) return "a number";
  if (Predicate.isBoolean(value)) return "a boolean";
  if (Predicate.isFunction(value)) return "a function";
  return "a non-plain object";
}

function isDraft(data: DocumentFields): boolean {
  return data.draft === true;
}

function toDocument(document: ValidatedDocument): TransformDocument {
  return { ...document.data, _meta: document.file.meta };
}

/** Group validated documents by source, in config order, drafts removed. Documents are ordered by configured locale order, then path. */
function groupBySource(
  project: ResolvedProject,
  documents: readonly ValidatedDocument[],
): SourceDocuments<ValidatedDocument>[] {
  const locales = project.localization?.locales ?? [];
  const localeRank = (locale: string | undefined) =>
    locale === undefined ? -1 : locales.indexOf(locale);
  return project.sources.map((source) => ({
    source,
    documents: documents
      .filter(
        (document) =>
          document.file.source.name === source.name && !document.draft,
      )
      .sort((a, b) => {
        const byLocale = localeRank(a.file.locale) - localeRank(b.file.locale);
        if (byLocale !== 0) return byLocale;
        const left = a.file.meta.filePath;
        const right = b.file.meta.filePath;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  }));
}

/**
 * Run every `transform`. Each transform sees the same frozen snapshot of
 * validated documents through `ctx.documents()`, whatever the source order,
 * and gets its own copy of its document. `_meta` is always re-attached.
 * Drafts (`draft: true`) and `ctx.skip()` results are dropped.
 */
export const runTransforms = Effect.fn("runTransforms")(function* (
  project: ResolvedProject,
  documents: readonly ValidatedDocument[],
): Effect.fn.Return<TransformResult> {
  const grouped = groupBySource(project, documents);
  const snapshots = new Map<string, readonly TransformDocument[]>();
  for (const group of grouped) {
    snapshots.set(
      group.source.name,
      group.documents.map((document) =>
        deepFreeze(structuredClone(toDocument(document))),
      ),
    );
  }
  const context: TransformContext = {
    documents: (source: AnyContent | string) => {
      const name = Predicate.isString(source) ? source : source.name;
      const snapshot = snapshots.get(name);
      if (!snapshot) {
        throw new Error(
          `ctx.documents("${name}"): no such collection or singleton in defineConfig({ content }).`,
        );
      }
      // SAFETY: snapshot documents are the validated schema output of that source plus `_meta`.
      return [...snapshot] as never[];
    },
    skip: createSkippedSignal,
  };

  const diagnostics: Diagnostic[] = [];
  const sources: SourceDocuments<FinalDocument>[] = [];
  for (const group of grouped) {
    const transform = group.source.definition.transform;
    const results = yield* Effect.forEach(
      group.documents,
      (document) => {
        const copy: TransformDocument = structuredClone(toDocument(document));
        if (!transform) {
          const { _meta: _ignored, ...data } = copy;
          return Effect.succeed<FinalDocument | undefined>({
            file: document.file,
            data,
            effects: document.effects,
          });
        }
        const failed = (message: string, cause?: unknown) =>
          errorDiagnostic("transform-failed", message, {
            file: document.file.absPath,
            source: group.source.name,
            cause,
          });
        return Effect.tryPromise({
          try: async () => transform(copy, context),
          catch: (cause) =>
            failed(`transform threw: ${messageOf(cause)}`, cause),
        }).pipe(
          Effect.timeoutOrElse({
            duration: TRANSFORM_TIMEOUT,
            orElse: () =>
              Effect.fail(
                failed(`transform did not finish within ${TRANSFORM_TIMEOUT}.`),
              ),
          }),
          Effect.flatMap(
            (result): Effect.Effect<FinalDocument | undefined, Diagnostic> => {
              if (isSkippedSignal(result)) return Effect.succeed(undefined);
              if (!isPlainObject(result)) {
                return Effect.fail(
                  failed(
                    `transform must return a plain object (or ctx.skip()), got ${describeValue(result)}.`,
                  ),
                );
              }
              const { _meta: _ignored, ...data } = result;
              if (isDraft(data)) return Effect.succeed(undefined);
              const problem = findNonPlainData(data);
              if (problem) {
                return Effect.fail({
                  ...failed(`transform output ${problem.message}.`),
                  fieldPath: problem.fieldPath,
                });
              }
              return Effect.succeed({
                file: document.file,
                data,
                effects: document.effects,
              });
            },
          ),
          Effect.catch((diagnostic: Diagnostic) =>
            Effect.sync(() => {
              diagnostics.push(diagnostic);
              return undefined;
            }),
          ),
        );
      },
      { concurrency: 8 },
    );
    sources.push({
      source: group.source,
      documents: results.filter(
        (result): result is FinalDocument => result !== undefined,
      ),
    });
  }
  return { sources, diagnostics };
});
