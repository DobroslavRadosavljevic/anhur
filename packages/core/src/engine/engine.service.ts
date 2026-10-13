import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Semaphore,
} from "effect";
import type { BuiltContentSnapshot } from "../define/types";
import {
  errorDiagnostic,
  hasErrors,
  messageOf,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import { isPlainObject, type DocumentFields } from "../document";
import type {
  AssetHost,
  AssetRef,
  AssetsInfo,
  BuildMode,
  EmittedModule,
  PluginPublishContext,
  SourceSnapshot,
} from "../plugin/types";
import { resolveAssetBases } from "./asset-urls";
import { BuildFailedError, buildFailed } from "./build-failed";
import {
  createPlanMemory,
  planOutput,
  type EmittedFile,
  type OutputFile,
  type PlanMemory,
  type PlanRevision,
} from "./codegen";
import { Collector, type CachedDocument } from "./collector.service";
import {
  CONFIG_FILE_NAMES,
  ConfigLoader,
  type LoadedProject,
} from "./config-loader.service";
import {
  checkUniqueness,
  createUniqueMemory,
  type UniqueMemory,
} from "./constraints";
import { createDeriveMemory, deriveAll, type DeriveMemory } from "./derive";
import { collectStoredDocuments } from "./document-store";
import { FieldCache } from "./field-cache.service";
import type { AssetHashEntry, FieldSession } from "./field-context";
import { copyData } from "./copy-data";
import { createSignatureMemo } from "./file-signature";
import { fileWork } from "./file-work";
import { deepFreeze } from "./freeze";
import { toExport } from "./list-rows";
import { OutputWriter } from "./output.service";
import {
  createRelationMemory,
  resolveRelations,
  type RelationMemory,
} from "./relations";
import type { ResolvedProject } from "./resolve";
import type {
  BuildOptions,
  BuildResult,
  SourceSummary,
  StageTiming,
  WatchTargets,
} from "./result";
import {
  createTransformMemory,
  runTransforms,
  type TransformMemory,
} from "./transform";
import type { FinalDocument, SourceDocuments } from "./types";

const HOOK_TIMEOUT = "5 minutes";
/** A session removes unused cache entries at most this often. */
const CLEANUP_INTERVAL_MS = 60_000;

type EngineState = {
  readonly loaded: LoadedProject | undefined;
  readonly configFiles: readonly string[];
  readonly watch: WatchTargets | undefined;
};

/** Summary and plugin snapshot of a source, kept while its documents stay the same. */
type SourceRecord = {
  readonly documents: readonly FinalDocument[];
  readonly summary: SourceSummary;
  readonly snapshot: SourceSnapshot;
};

/**
 * What the stages after validation remember between the builds of one
 * session, so a build redoes work only for the documents that changed.
 * Everything here belongs to one loaded project and is dropped when the
 * config is loaded again.
 */
type BuildMemory = {
  readonly project: ResolvedProject;
  readonly transforms: TransformMemory;
  readonly relations: RelationMemory;
  readonly uniques: UniqueMemory;
  readonly derived: DeriveMemory;
  readonly plan: PlanMemory;
  readonly sources: Map<string, SourceRecord>;
  /** Watch targets of the last build that found no changed document. */
  watch: WatchTargets | undefined;
};

function createBuildMemory(project: ResolvedProject): BuildMemory {
  return {
    project,
    transforms: createTransformMemory(),
    relations: createRelationMemory(),
    uniques: createUniqueMemory(),
    derived: createDeriveMemory(),
    plan: createPlanMemory(),
    sources: new Map(),
    watch: undefined,
  };
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Hook failure as a build failure. */
function hookFailed(
  label: string,
  cause: unknown,
  published: boolean,
): BuildFailedError {
  return buildFailed([
    errorDiagnostic("hook-failed", `${label} failed: ${messageOf(cause)}`, {
      cause,
      hint: published
        ? "The output was already published; fix the hook and rebuild."
        : undefined,
    }),
  ]);
}

/** `devBase` in dev mode when the asset plugin sets one, `base` otherwise. */
function assetBaseFor(host: AssetHost, mode: BuildMode): string {
  return mode === "dev" && host.devBase ? host.devBase : host.base;
}

/**
 * Summary and plugin snapshot of every source. A source whose documents
 * are the same objects as in the last build keeps the same record, so
 * plugins can tell an unchanged source (and document) by identity.
 */
function sourceRecords(
  memory: BuildMemory,
  sources: readonly SourceDocuments<FinalDocument>[],
): SourceRecord[] {
  const names = new Set(sources.map((group) => group.source.name));
  for (const name of memory.sources.keys()) {
    if (!names.has(name)) memory.sources.delete(name);
  }
  return sources.map((group) => {
    const known = memory.sources.get(group.source.name);
    if (known && sameItems(known.documents, group.documents)) return known;
    const record: SourceRecord = {
      documents: [...group.documents],
      summary: {
        name: group.source.name,
        kind: group.source.kind,
        documents: group.documents.map((document) =>
          document.file.locale
            ? `${document.file.locale}/${document.file.id}`
            : document.file.id,
        ),
      },
      snapshot: {
        name: group.source.name,
        type: group.source.kind,
        localized: group.source.localized,
        documents: group.documents.map(toExport),
      },
    };
    memory.sources.set(group.source.name, record);
    return record;
  });
}

function snapshotsOf(
  sources: readonly SourceDocuments<FinalDocument>[],
): BuiltContentSnapshot[] {
  return sources.map((group) => ({
    name: group.source.name,
    type: group.source.kind,
    documents: group.documents.map(toExport),
  }));
}

function uniqueAssets(
  sources: readonly SourceDocuments<FinalDocument>[],
): AssetRef[] {
  const byPath = new Map<string, AssetRef>();
  for (const group of sources) {
    for (const document of group.documents) {
      for (const asset of document.effects.assets)
        byPath.set(asset.sourcePath, asset);
    }
  }
  return [...byPath.values()].sort((a, b) =>
    a.fileName < b.fileName ? -1 : 1,
  );
}

function watchTargetsOf(
  project: ResolvedProject,
  configFiles: readonly string[],
  sources: readonly SourceDocuments<FinalDocument>[],
  assetsDir: string | undefined,
): WatchTargets {
  const directories = new Set<string>();
  const files = new Set<string>(configFiles);
  for (const source of project.sources) {
    if (source.kind === "singleton" && source.filePath)
      files.add(source.filePath);
    else directories.add(source.root);
  }
  for (const group of sources) {
    for (const document of group.documents) {
      for (const dependency of document.effects.dependencies)
        files.add(dependency);
      for (const asset of document.effects.assets) files.add(asset.sourcePath);
    }
  }
  const ignore = [project.outputDir, `${project.outputDir}.lock`];
  if (project.cacheDir) ignore.push(project.cacheDir);
  if (assetsDir) ignore.push(assetsDir);
  return {
    directories: [...directories].sort(),
    files: [...files].sort(),
    ignore,
  };
}

/**
 * Runs builds for one session: load config → discover → validate →
 * transform → prepare → relations → uniqueness → views → plugins → plan →
 * publish.
 *
 * A session keeps the validated documents and what every later stage made
 * of them ({@link BuildMemory}). Documents are never changed in place, so
 * an unchanged document is the same object in every build and a rebuild
 * redoes work only for the files that changed.
 */
export class Engine extends Context.Service<
  Engine,
  {
    readonly build: (
      options: BuildOptions,
    ) => Effect.Effect<BuildResult, BuildFailedError>;
    /** What to watch now (also after a failed build). */
    readonly watchTargets: (
      options: BuildOptions,
    ) => Effect.Effect<WatchTargets>;
  }
>()("@anhur/core/engine/Engine") {
  static readonly layer = Layer.effect(
    Engine,
    Effect.gen(function* () {
      const configLoader = yield* ConfigLoader;
      const collector = yield* Collector;
      const writer = yield* OutputWriter;
      const fieldCache = yield* FieldCache;
      const state = yield* Ref.make<EngineState>({
        loaded: undefined,
        configFiles: [],
        watch: undefined,
      });
      const documentCache = new Map<string, CachedDocument>();
      const hashes = new Map<string, AssetHashEntry>();
      /** Set by the first build and whenever the loaded project changes. */
      let memory: BuildMemory | undefined;
      /** Cache entries may have become unused since the last clean-up. */
      let cachesDirty = true;
      /** Epoch milliseconds of the last clean-up (`undefined`: none yet). */
      let cleanedAt: number | undefined;
      // Builds of one session share caches and state: run them one at a time
      // so an older build can never publish over a newer one.
      const buildPermit = yield* Semaphore.make(1);

      const runHook = Effect.fn("Engine.runHook")(function* (
        label: string,
        run: () => void | Promise<void>,
        published: boolean,
      ) {
        yield* Effect.tryPromise({
          try: async () => {
            await run();
          },
          catch: (cause) => hookFailed(label, cause, published),
        }).pipe(
          Effect.timeoutOrElse({
            duration: HOOK_TIMEOUT,
            orElse: () =>
              Effect.fail(
                hookFailed(
                  label,
                  new Error(`did not finish within ${HOOK_TIMEOUT}`),
                  published,
                ),
              ),
          }),
        );
      });

      const fieldSession = Effect.fn("Engine.fieldSession")(function* (
        project: ResolvedProject,
        options: BuildOptions,
      ) {
        const host = project.assetHost;
        const publicBase = host
          ? resolveAssetBases(
              assetBaseFor(host.host, project.mode),
              options.publicPathPrefix,
            ).publicBase
          : undefined;
        // Native real paths have the case the disk has, like the real
        // paths of the files compared with them.
        const assetRoots = yield* fileWork(() =>
          Promise.all(
            (host?.roots ?? []).map((root) =>
              realpath(root).catch(() => path.resolve(root)),
            ),
          ),
        );
        const session: FieldSession = {
          project,
          publicBase,
          assetRoots,
          hashes,
          stats: createSignatureMemo(),
          emitted: new Map(),
        };
        return session;
      });

      const prepare = Effect.fn("Engine.prepare")(function* (
        project: ResolvedProject,
        sources: SourceDocuments<FinalDocument>[],
      ) {
        const hook = project.config.prepare;
        if (!hook) return;
        // The hook may edit documents: it gets its own copies.
        const snapshots = snapshotsOf(sources).map((snapshot) => ({
          ...snapshot,
          documents: snapshot.documents.map((document) => copyData(document)),
        }));
        yield* runHook("prepare", () => hook(snapshots), false);
        const diagnostics: Diagnostic[] = [];
        for (const snapshot of snapshots) {
          const group = sources.find(
            (candidate) => candidate.source.name === snapshot.name,
          );
          if (!group) continue;
          const byPath = new Map(
            group.documents.map((document) => [
              document.file.meta.filePath,
              document,
            ]),
          );
          const next: FinalDocument[] = [];
          for (const document of snapshot.documents) {
            const meta: DocumentFields | undefined =
              isPlainObject(document) && isPlainObject(document._meta)
                ? document._meta
                : undefined;
            const original =
              meta && Predicate.isString(meta.filePath)
                ? byPath.get(meta.filePath)
                : undefined;
            if (!original) {
              diagnostics.push(
                errorDiagnostic(
                  "hook-failed",
                  `prepare: documents of "${snapshot.name}" must be the given objects (with their _meta); adding new documents is not supported.`,
                  {
                    source: snapshot.name,
                  },
                ),
              );
              continue;
            }
            const { _meta: _ignored, ...data } = document;
            next.push({
              file: original.file,
              data: deepFreeze(data),
              effects: original.effects,
              origin: original.origin,
            });
          }
          group.documents = next;
        }
        if (hasErrors(diagnostics))
          return yield* Effect.fail(buildFailed(diagnostics));
      });

      const generateFromPlugins = Effect.fn("Engine.generateFromPlugins")(
        function* (
          project: ResolvedProject,
          snapshots: readonly SourceSnapshot[],
        ) {
          const modules: (EmittedModule & { readonly plugin: string })[] = [];
          const files: EmittedFile[] = [];
          const warnings: Diagnostic[] = [];
          for (const plugin of project.plugins) {
            const generate = plugin.generate;
            if (!generate) continue;
            yield* runHook(
              `Plugin "${plugin.name}" generate`,
              () =>
                generate({
                  projectDir: project.projectDir,
                  outputDir: project.outputDir,
                  mode: project.mode,
                  locales: project.localization?.locales ?? [],
                  defaultLocale: project.localization?.defaultLocale,
                  sources: snapshots,
                  emitModule: (module) => {
                    modules.push({ ...module, plugin: plugin.name });
                  },
                  emitFile: (filePath, contents) => {
                    files.push({
                      path: filePath,
                      contents,
                      plugin: plugin.name,
                    });
                  },
                  warn: (message) => {
                    warnings.push(
                      warningDiagnostic(
                        "plugin-failed",
                        `Plugin "${plugin.name}": ${message}`,
                      ),
                    );
                  },
                }),
              false,
            );
          }
          return { modules, files, warnings };
        },
      );

      const publish = Effect.fn("Engine.publish")(function* (
        project: ResolvedProject,
        sources: readonly SourceDocuments<FinalDocument>[],
        files: readonly OutputFile[],
        revision: PlanRevision,
        assets: readonly AssetRef[],
        assetsInfo: AssetsInfo | undefined,
        assetsDir: string | undefined,
        messages: string[],
        warnings: Diagnostic[],
      ) {
        yield* writer.checkOwnership(project.outputDir);
        yield* writer.lock(project.outputDir);
        const context: PluginPublishContext = {
          projectDir: project.projectDir,
          outputDir: project.outputDir,
          mode: project.mode,
          assets,
          assetsInfo,
          assetsDir,
          info: (message) => {
            messages.push(message);
          },
          warn: (message) => {
            warnings.push(warningDiagnostic("plugin-failed", message));
          },
        };
        for (const plugin of project.plugins) {
          const hook = plugin.beforePublish;
          if (hook)
            yield* runHook(
              `Plugin "${plugin.name}" beforePublish`,
              () => hook(context),
              false,
            );
        }
        const written = yield* writer.write(project.outputDir, files, revision);
        for (const plugin of project.plugins) {
          const hook = plugin.afterPublish;
          if (hook)
            yield* runHook(
              `Plugin "${plugin.name}" afterPublish`,
              () => hook(context),
              true,
            );
        }
        const complete = project.config.complete;
        const hooked =
          complete !== undefined ||
          sources.some((group) => group.source.definition.onSuccess);
        if (!hooked) return written;
        const snapshots = snapshotsOf(sources);
        for (const snapshot of snapshots) Object.freeze(snapshot.documents);
        for (const group of sources) {
          const onSuccess = group.source.definition.onSuccess;
          const documents =
            snapshots.find((snapshot) => snapshot.name === group.source.name)
              ?.documents ?? [];
          if (onSuccess) {
            yield* runHook(
              `onSuccess of "${group.source.name}"`,
              () => onSuccess(documents),
              true,
            );
          }
        }
        if (complete) {
          yield* runHook(
            "complete",
            () =>
              complete(snapshots, {
                projectDir: project.projectDir,
                outputDir: project.outputDir,
              }),
            true,
          );
        }
        return written;
      }, Effect.scoped);

      const fallbackTargets = Effect.fn("Engine.fallbackTargets")(function* (
        options: BuildOptions,
      ) {
        const rootDir = path.resolve(options.rootDir ?? process.cwd());
        const current = yield* Ref.get(state);
        const inspected = yield* configLoader
          .inspect({
            rootDir,
            configPath: options.configPath,
            mode: options.mode ?? "build",
          })
          .pipe(Effect.option);
        const files = Option.isSome(inspected)
          ? [...inspected.value.files]
          : current.configFiles.length > 0
            ? [...current.configFiles]
            : options.configPath
              ? [path.resolve(rootDir, options.configPath)]
              : CONFIG_FILE_NAMES.map((name) => path.join(rootDir, name));
        const previous = current.watch;
        return {
          directories: previous?.directories ?? [],
          files: [...new Set([...files, ...(previous?.files ?? [])])],
          ignore: previous?.ignore ?? [],
        };
      });

      const runBuild = Effect.fn("Engine.runBuild")(function* (
        options: BuildOptions,
      ) {
        const rootDir = path.resolve(options.rootDir ?? process.cwd());
        const mode = options.mode ?? "build";
        const timings: StageTiming[] = [];
        let mark = performance.now();
        /** The time since the last call belongs to `stage`. */
        const timed = (stage: string): void => {
          const now = performance.now();
          timings.push({ stage, ms: now - mark });
          mark = now;
        };
        const current = yield* Ref.get(state);
        const loaded = yield* configLoader.load({
          rootDir,
          configPath: options.configPath,
          mode,
          previous: current.loaded,
        });
        timed("config");
        yield* Ref.update(state, (value) => ({
          ...value,
          loaded,
          configFiles: loaded.configFiles,
        }));
        const project = loaded.project;
        const warnings: Diagnostic[] = [...loaded.warnings];
        const messages: string[] = [];
        const host = project.assetHost;
        const assetsDir = host?.host.dir
          ? path.resolve(project.projectDir, host.host.dir)
          : undefined;

        // Watch the content folders as soon as the config is known, so a
        // session whose first build fails still rebuilds when files are fixed.
        const previousWatch = current.watch;
        const baseWatch = watchTargetsOf(
          project,
          loaded.configFiles,
          [],
          assetsDir,
        );
        yield* Ref.update(state, (value) => ({
          ...value,
          watch: {
            ...baseWatch,
            files: [
              ...new Set([...baseWatch.files, ...(previousWatch?.files ?? [])]),
            ].sort(),
          },
        }));

        if (!memory || memory.project !== project) {
          memory = createBuildMemory(project);
        }
        const remembered = memory;

        const discovered = yield* collector.discover(project);
        timed("discover");
        const session = yield* fieldSession(project, options);
        const validated = yield* collector.validate(
          project,
          discovered.files,
          session,
          documentCache,
          { dryRun: options.dryRun === true },
        );
        timed("validate");
        if (validated.changed) cachesDirty = true;
        const collectDiagnostics = [
          ...discovered.diagnostics,
          ...validated.diagnostics,
        ];
        warnings.push(
          ...collectDiagnostics.filter(
            (diagnostic) => diagnostic.severity === "warning",
          ),
        );
        if (hasErrors(collectDiagnostics))
          return yield* Effect.fail(buildFailed(collectDiagnostics));

        const transformed = yield* runTransforms(
          project,
          validated.documents,
          remembered.transforms,
        );
        timed("transform");
        if (hasErrors(transformed.diagnostics))
          return yield* Effect.fail(buildFailed(transformed.diagnostics));
        const sources = transformed.sources;

        // `prepare` may still edit or drop documents, so references and
        // uniqueness are checked on what it leaves.
        yield* prepare(project, sources);
        const linkDiagnostics = [
          ...resolveRelations(project, sources, remembered.relations),
          ...checkUniqueness(sources, remembered.uniques),
        ];
        timed("relations");
        if (hasErrors(linkDiagnostics))
          return yield* Effect.fail(buildFailed(linkDiagnostics));

        const derived = deriveAll(project.derived, sources, remembered.derived);
        timed("views");
        if (hasErrors(derived.diagnostics))
          return yield* Effect.fail(buildFailed(derived.diagnostics));

        const records = sourceRecords(remembered, sources);
        const generated = yield* generateFromPlugins(
          project,
          records.map((record) => record.snapshot),
        );
        warnings.push(...generated.warnings);
        timed("plugins");
        const plan = planOutput(
          {
            project,
            sources,
            derived: derived.results,
            modules: generated.modules,
            files: generated.files,
          },
          remembered.plan,
        );
        timed("plan");
        if (hasErrors(plan.diagnostics))
          return yield* Effect.fail(buildFailed(plan.diagnostics));
        warnings.push(
          ...plan.diagnostics.filter(
            (diagnostic) => diagnostic.severity === "warning",
          ),
        );

        const bases = host
          ? resolveAssetBases(
              assetBaseFor(host.host, project.mode),
              options.publicPathPrefix,
            )
          : undefined;
        const assetsInfo: AssetsInfo | undefined = bases
          ? { publicBase: bases.publicBase, localBase: bases.localBase }
          : undefined;
        // The targets come from the documents: the same documents, the same targets.
        const watch =
          !validated.changed && remembered.watch
            ? remembered.watch
            : watchTargetsOf(project, loaded.configFiles, sources, assetsDir);
        remembered.watch = watch;
        yield* Ref.update(state, (value) => ({ ...value, watch }));
        const assets = uniqueAssets(sources);

        let written: readonly string[] = [];
        let removed: readonly string[] = [];
        if (options.dryRun) {
          // `check` must fail wherever `build` would refuse to write.
          yield* writer.checkOwnership(project.outputDir);
        } else {
          const result = yield* publish(
            project,
            sources,
            plan.files,
            plan.revision,
            assets,
            assetsInfo,
            assetsDir,
            messages,
            warnings,
          );
          written = result.written;
          removed = result.removed;
          timed("publish");
          const cacheDir = project.cacheDir;
          const now = yield* Clock.currentTimeMillis;
          // Entries only become unused when a document changed or went
          // away. Listing the cache folders is not free: while a session
          // rebuilds on every save, it cleans up once in a while (the
          // first build of the next session cleans up what is left).
          if (
            cacheDir !== undefined &&
            cachesDirty &&
            (cleanedAt === undefined || now - cleanedAt >= CLEANUP_INTERVAL_MS)
          ) {
            const fields = new Set<string>();
            const stored = new Set<string>();
            for (const cached of documentCache.values()) {
              for (const key of cached.document.effects.cacheKeys)
                fields.add(key);
              if (cached.storeKey !== undefined) stored.add(cached.storeKey);
            }
            yield* fieldCache.collect(cacheDir, fields);
            yield* fileWork(() => collectStoredDocuments(cacheDir, stored));
            cachesDirty = false;
            cleanedAt = now;
            timed("cleanup");
          }
        }

        const summary = records.map((record) => record.summary);
        const result: BuildResult = {
          configPath: project.configPath,
          projectDir: project.projectDir,
          outputDir: project.outputDir,
          mode,
          sources: summary,
          documentCount: summary.reduce(
            (total, source) => total + source.documents.length,
            0,
          ),
          written,
          removed,
          assets:
            assetsInfo === undefined
              ? undefined
              : {
                  dir: assetsDir,
                  publicBase: assetsInfo.publicBase,
                  localBase: assetsInfo.localBase,
                  count: assets.length,
                },
          watch,
          warnings,
          messages,
          dryRun: options.dryRun === true,
          timings,
        };
        return result;
      });

      const build = (options: BuildOptions) =>
        buildPermit.withPermits(1)(runBuild(options));

      const watchTargets = Effect.fn("Engine.watchTargets")(function* (
        options: BuildOptions,
      ) {
        const current = yield* Ref.get(state);
        if (current.watch) {
          return {
            ...current.watch,
            files: [
              ...new Set([...current.watch.files, ...current.configFiles]),
            ],
          };
        }
        return yield* fallbackTargets(options);
      });

      return Engine.of({ build, watchTargets });
    }),
  );
}
