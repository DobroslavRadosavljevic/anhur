import path from "node:path";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Semaphore,
} from "effect";
import type { BuiltContentSnapshot, TransformDocument } from "../define/types";
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
import { planOutput, type OutputFile } from "./codegen";
import { Collector, type CachedDocument } from "./collector.service";
import {
  CONFIG_FILE_NAMES,
  ConfigLoader,
  type LoadedProject,
} from "./config-loader.service";
import { checkUniqueness } from "./constraints";
import { deriveAll } from "./derive";
import { FieldCache } from "./field-cache.service";
import type { AssetHashEntry, FieldSession } from "./field-context";
import { deepFreeze } from "./freeze";
import { toExport } from "./list-rows";
import { OutputWriter } from "./output.service";
import { resolveRelations } from "./relations";
import type { ResolvedProject } from "./resolve";
import type {
  BuildOptions,
  BuildResult,
  SourceSummary,
  WatchTargets,
} from "./result";
import { runTransforms } from "./transform";
import type { FinalDocument, SourceDocuments } from "./types";

const HOOK_TIMEOUT = "5 minutes";

type EngineState = {
  readonly loaded: LoadedProject | undefined;
  readonly configFiles: readonly string[];
  readonly watch: WatchTargets | undefined;
};

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

function summaryOf(
  sources: readonly SourceDocuments<FinalDocument>[],
): SourceSummary[] {
  return sources.map((group) => ({
    name: group.source.name,
    kind: group.source.kind,
    documents: group.documents.map((document) =>
      document.file.locale
        ? `${document.file.locale}/${document.file.id}`
        : document.file.id,
    ),
  }));
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
 * Runs builds for one session: load config → collect → transform →
 * relations → constraints → prepare → derive → plugins → plan → publish.
 * Keeps validated documents between builds, so a rebuild only re-reads the
 * files whose content or dependencies changed.
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
      const fs = yield* FileSystem.FileSystem;
      const state = yield* Ref.make<EngineState>({
        loaded: undefined,
        configFiles: [],
        watch: undefined,
      });
      const documentCache = new Map<string, CachedDocument>();
      const hashes = new Map<string, AssetHashEntry>();
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
        const assetRoots: string[] = [];
        for (const root of host?.roots ?? []) {
          assetRoots.push(
            yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root)),
          );
        }
        const session: FieldSession = {
          project,
          publicBase,
          assetRoots,
          hashes,
        };
        return session;
      });

      const prepare = Effect.fn("Engine.prepare")(function* (
        project: ResolvedProject,
        sources: SourceDocuments<FinalDocument>[],
      ) {
        const hook = project.config.prepare;
        if (!hook) return;
        const snapshots = snapshotsOf(sources).map((snapshot) => ({
          ...snapshot,
          documents: snapshot.documents.map((document) =>
            structuredClone(document),
          ),
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
            next.push({ file: original.file, data, effects: original.effects });
          }
          group.documents = next;
        }
        if (hasErrors(diagnostics))
          return yield* Effect.fail(buildFailed(diagnostics));
      });

      const generateFromPlugins = Effect.fn("Engine.generateFromPlugins")(
        function* (
          project: ResolvedProject,
          sources: readonly SourceDocuments<FinalDocument>[],
        ) {
          const modules: (EmittedModule & { readonly plugin: string })[] = [];
          const files: (OutputFile & { readonly plugin: string })[] = [];
          const warnings: Diagnostic[] = [];
          const snapshots: SourceSnapshot[] = sources.map((group) => ({
            name: group.source.name,
            type: group.source.kind,
            localized: group.source.localized,
            documents: group.documents.map((document): TransformDocument =>
              toExport(document),
            ),
          }));
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
          assets: uniqueAssets(sources),
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
        const written = yield* writer.write(project.outputDir, files);
        for (const plugin of project.plugins) {
          const hook = plugin.afterPublish;
          if (hook)
            yield* runHook(
              `Plugin "${plugin.name}" afterPublish`,
              () => hook(context),
              true,
            );
        }
        const snapshots = snapshotsOf(sources);
        for (const snapshot of snapshots) deepFreeze(snapshot.documents);
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
        const complete = project.config.complete;
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
        const current = yield* Ref.get(state);
        const loaded = yield* configLoader.load({
          rootDir,
          configPath: options.configPath,
          mode,
          previous: current.loaded,
        });
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

        const discovered = yield* collector.discover(project);
        const session = yield* fieldSession(project, options);
        const validated = yield* collector.validate(
          project,
          discovered.files,
          session,
          documentCache,
          { dryRun: options.dryRun === true },
        );
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

        const transformed = yield* runTransforms(project, validated.documents);
        if (hasErrors(transformed.diagnostics))
          return yield* Effect.fail(buildFailed(transformed.diagnostics));
        const sources = transformed.sources;

        // `prepare` may still edit or drop documents, so references and
        // uniqueness are checked on what it leaves.
        yield* prepare(project, sources);
        const linkDiagnostics = [
          ...resolveRelations(project, sources, validated.documents),
          ...checkUniqueness(sources),
        ];
        if (hasErrors(linkDiagnostics))
          return yield* Effect.fail(buildFailed(linkDiagnostics));
        for (const group of sources) {
          for (const document of group.documents) deepFreeze(document.data);
        }

        const derived = deriveAll(project.derived, sources);
        if (hasErrors(derived.diagnostics))
          return yield* Effect.fail(buildFailed(derived.diagnostics));

        const generated = yield* generateFromPlugins(project, sources);
        warnings.push(...generated.warnings);
        const plan = planOutput({
          project,
          sources,
          derived: derived.results,
          modules: generated.modules,
          files: generated.files,
        });
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
        const watch = watchTargetsOf(
          project,
          loaded.configFiles,
          sources,
          assetsDir,
        );
        yield* Ref.update(state, (value) => ({ ...value, watch }));

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
            assetsInfo,
            assetsDir,
            messages,
            warnings,
          );
          written = result.written;
          removed = result.removed;
          if (project.cacheDir) {
            const keep = new Set<string>();
            for (const cached of documentCache.values()) {
              for (const key of cached.document.effects.cacheKeys)
                keep.add(key);
            }
            yield* fieldCache.collect(project.cacheDir, keep);
          }
        }

        const summary = summaryOf(sources);
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
                  count: uniqueAssets(sources).length,
                },
          watch,
          warnings,
          messages,
          dryRun: options.dryRun === true,
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
