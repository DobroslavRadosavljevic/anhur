import { Effect, Predicate } from "effect";
import { createSkippedSignal, isSkippedSignal } from "../define/content";
import type {
  AnyContent,
  TransformContext,
  TransformDocument,
} from "../define/types";
import { errorDiagnostic, messageOf, type Diagnostic } from "../diagnostics";
import { isPlainObject, type DocumentFields } from "../document";
import { copyData } from "./copy-data";
import { deepFreeze } from "./freeze";
import { toSnapshot } from "./list-rows";
import { findNonPlainData } from "./plain-data";
import type { ResolvedProject, ResolvedSource } from "./resolve";
import { sameData } from "./same-data";
import { sameItems } from "./same-items";
import type {
  FinalDocument,
  SourceDocuments,
  ValidatedDocument,
} from "./types";

const TRANSFORM_TIMEOUT = "5 minutes";
const TRANSFORM_CONCURRENCY = 8;

export type TransformResult = {
  readonly sources: SourceDocuments<FinalDocument>[];
  readonly diagnostics: readonly Diagnostic[];
};

/** What `ctx.documents(name)` returned, by source name. */
type SnapshotReads = ReadonlyMap<string, readonly TransformDocument[]>;

/** The result of one transform run and the snapshots it read. */
type TransformRecord = {
  /** `undefined`: the document was skipped (or became a draft). */
  readonly final: FinalDocument | undefined;
  readonly reads: SnapshotReads;
};

/** `ctx.documents()` result of a source, kept while its documents stay the same. */
type SnapshotRecord = {
  readonly documents: readonly ValidatedDocument[];
  readonly snapshot: readonly TransformDocument[];
};

/**
 * What a session remembers about transforms between builds: the final
 * document of every validated document, so only changed documents (and
 * documents whose transform read a source that changed) are transformed
 * again.
 */
export type TransformMemory = {
  /** Sources without a transform: the document as validated. */
  readonly unchanged: WeakMap<ValidatedDocument, FinalDocument>;
  /**
   * The last run of every transform, also with `transformCache: false`:
   * a run that gives the same data again keeps the final document of the
   * run before.
   */
  readonly records: WeakMap<ValidatedDocument, TransformRecord>;
  readonly snapshots: Map<string, SnapshotRecord>;
};

export function createTransformMemory(): TransformMemory {
  return {
    unchanged: new WeakMap(),
    records: new WeakMap(),
    snapshots: new Map(),
  };
}

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

/** Group validated documents by source, in config order, drafts removed. Documents are ordered by configured locale order, then path. */
function groupBySource(
  project: ResolvedProject,
  documents: readonly ValidatedDocument[],
): SourceDocuments<ValidatedDocument>[] {
  const locales = project.localization?.locales ?? [];
  const ranks = new Map(locales.map((locale, index) => [locale, index]));
  const localeRank = (locale: string | undefined) =>
    locale === undefined ? -1 : (ranks.get(locale) ?? -1);
  const byName = new Map<string, ValidatedDocument[]>();
  for (const document of documents) {
    if (document.draft) continue;
    const name = document.file.source.name;
    const list = byName.get(name);
    if (list) list.push(document);
    else byName.set(name, [document]);
  }
  return project.sources.map((source) => ({
    source,
    documents: (byName.get(source.name) ?? []).sort((a, b) => {
      const byLocale = localeRank(a.file.locale) - localeRank(b.file.locale);
      if (byLocale !== 0) return byLocale;
      const left = a.file.meta.filePath;
      const right = b.file.meta.filePath;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  }));
}

/** Final document of a source without a transform: the validated data itself. */
function unchangedDocument(
  memory: TransformMemory,
  document: ValidatedDocument,
): FinalDocument {
  let final = memory.unchanged.get(document);
  if (!final) {
    final = {
      file: document.file,
      data: document.data,
      effects: document.effects,
      origin: document,
    };
    memory.unchanged.set(document, final);
  }
  return final;
}

/**
 * Run every `transform`. Each transform sees the same frozen snapshot of
 * validated documents through `ctx.documents()`, whatever the source order,
 * and gets its own copy of its document. `_meta` is always re-attached.
 * Drafts (`draft: true`) and `ctx.skip()` results are dropped.
 *
 * With a `memory`, a transform only runs again when its document changed
 * or a source it read through `ctx.documents()` has other documents now
 * (unless the source sets `transformCache: false`). A transform that runs
 * again for the same validated document and returns the same data
 * ({@link sameData}) keeps the final document it had: the later stages
 * know a document by its identity. Documents of sources without a
 * transform keep their validated data as is.
 */
export const runTransforms = Effect.fn("runTransforms")(function* (
  project: ResolvedProject,
  documents: readonly ValidatedDocument[],
  memory: TransformMemory = createTransformMemory(),
): Effect.fn.Return<TransformResult> {
  const grouped = groupBySource(project, documents);
  const groups = new Map(grouped.map((group) => [group.source.name, group]));
  for (const [name, record] of memory.snapshots) {
    const group = groups.get(name);
    if (!group || !sameItems(record.documents, group.documents)) {
      memory.snapshots.delete(name);
    }
  }
  /** Snapshot of a source, or `undefined` for an unknown name. */
  const snapshotOf = (
    name: string,
  ): readonly TransformDocument[] | undefined => {
    const known = memory.snapshots.get(name);
    if (known) return known.snapshot;
    const group = groups.get(name);
    if (!group) return undefined;
    const snapshot = group.documents.map(toSnapshot);
    memory.snapshots.set(name, { documents: [...group.documents], snapshot });
    return snapshot;
  };
  const isCurrent = (record: TransformRecord): boolean => {
    for (const [name, snapshot] of record.reads) {
      if (snapshotOf(name) !== snapshot) return false;
    }
    return true;
  };

  const diagnostics: Diagnostic[] = [];
  const sources: SourceDocuments<FinalDocument>[] = [];
  for (const group of grouped) {
    const source: ResolvedSource = group.source;
    const transform = source.definition.transform;
    if (!transform) {
      sources.push({
        source,
        documents: group.documents.map((document) =>
          unchangedDocument(memory, document),
        ),
      });
      continue;
    }
    const remember = source.definition.transformCache !== false;
    const results = new Map<ValidatedDocument, FinalDocument | undefined>();
    const pending: ValidatedDocument[] = [];
    for (const document of group.documents) {
      const record = memory.records.get(document);
      if (remember && record && isCurrent(record)) {
        results.set(document, record.final);
      } else pending.push(document);
    }
    yield* Effect.forEach(
      pending,
      (document) => {
        const reads = new Map<string, readonly TransformDocument[]>();
        const context: TransformContext = {
          documents: (target: AnyContent | string) => {
            const name = Predicate.isString(target) ? target : target.name;
            const snapshot = snapshotOf(name);
            if (!snapshot) {
              throw new Error(
                `ctx.documents("${name}"): no such collection or singleton in defineConfig({ content }).`,
              );
            }
            reads.set(name, snapshot);
            // SAFETY: snapshot documents are the validated schema output of that source plus `_meta`.
            return [...snapshot] as never[];
          },
          skip: createSkippedSignal,
        };
        // The transform may change its document: it gets its own copy.
        const copy: TransformDocument = copyData({
          ...document.data,
          _meta: document.file.meta,
        });
        const failed = (message: string, cause?: unknown) =>
          errorDiagnostic("transform-failed", message, {
            file: document.file.absPath,
            source: source.name,
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
              const previous = memory.records.get(document)?.final;
              if (previous && sameData(previous.data, data)) {
                return Effect.succeed(previous);
              }
              return Effect.succeed({
                file: document.file,
                data: deepFreeze(data),
                effects: document.effects,
                origin: document,
              });
            },
          ),
          Effect.map((final) => {
            results.set(document, final);
            memory.records.set(document, { final, reads });
          }),
          Effect.catch((diagnostic: Diagnostic) =>
            Effect.sync(() => {
              diagnostics.push(diagnostic);
            }),
          ),
        );
      },
      { concurrency: TRANSFORM_CONCURRENCY, discard: true },
    );
    const finals: FinalDocument[] = [];
    for (const document of group.documents) {
      const final = results.get(document);
      if (final) finals.push(final);
    }
    sources.push({ source, documents: finals });
  }
  return { sources, diagnostics };
});
