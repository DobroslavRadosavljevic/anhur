import { createHash } from "node:crypto";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
} from "effect";
import type { z } from "zod";
import {
  errorDiagnostic,
  messageOf,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import {
  isPlainObject,
  writePath,
  type ContentMeta,
  type DocumentFields,
  type DocumentValue,
} from "../document";
import { builtinLoaders, findLoader } from "../loaders";
import type { CompileFieldSpec, LoadedFile } from "../plugin/types";
import { installedVersion } from "../plugin/versions";
import { walkInput, type FieldOccurrence } from "../schema/walk";
import {
  createEffectRecorder,
  createFieldContext,
  emitAssetFile,
  type EffectRecorder,
  type FieldSession,
} from "./field-context";
import { FieldCache, type CachedDependency } from "./field-cache.service";
import { fingerprint } from "./fingerprint";
import { isInside, relativeTo, toPosix } from "./paths";
import { canCache } from "./cache-codec";
import { findNonPlainData } from "./plain-data";
import type { ResolvedProject, ResolvedSource } from "./resolve";
import type { SourceFile, ValidatedDocument } from "./types";

const LOAD_TIMEOUT = "1 minute";
const FIELD_TIMEOUT = "5 minutes";
const VALIDATE_TIMEOUT = "5 minutes";
const FILE_CONCURRENCY = 8;
const FIELD_CONCURRENCY = 4;
/** Part of every field cache key: a core upgrade can change field output. */
const CORE_VERSION = installedVersion("@anhur/core", import.meta.url);
/** Never traversed while looking for content. */
const DISCOVER_EXCLUDE = ["**/node_modules/**", "**/.*/**"];

/** Key of a document in the session cache: the same file may belong to several sources. */
export function documentCacheKey(file: SourceFile): string {
  return `${file.source.name}\u0000${file.absPath}`;
}

/** A validated document remembered between builds of one session. */
export type CachedDocument = {
  readonly hash: string;
  readonly projectFingerprint: string;
  readonly publicBase: string | undefined;
  readonly dependencies: readonly CachedDependency[];
  readonly document: ValidatedDocument;
  /** Warnings of the validation that produced `document`, replayed on reuse. */
  readonly warnings: readonly Diagnostic[];
};

/** Per-build options of {@link Collector.validate}. */
export type ValidateOptions = {
  /** `anhur check`: read the field cache, never write it. */
  readonly dryRun: boolean;
};

export type DiscoverResult = {
  readonly files: readonly SourceFile[];
  readonly diagnostics: readonly Diagnostic[];
};

export type ValidateResult = {
  readonly documents: readonly ValidatedDocument[];
  readonly diagnostics: readonly Diagnostic[];
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stripExtension(relative: string): string {
  const slash = relative.lastIndexOf("/");
  const dot = relative.lastIndexOf(".");
  return dot > slash + 1 ? relative.slice(0, dot) : relative;
}

function hasHiddenSegment(relative: string): boolean {
  return relative.split("/").some((segment) => segment.startsWith("."));
}

function issuePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((segment) =>
    Predicate.isNumber(segment) ? segment : String(segment),
  );
}

/** Apply a timeout to user / plugin code, failing with a diagnostic. */
function withTimeout<A>(
  effect: Effect.Effect<A, Diagnostic>,
  duration: "1 minute" | "5 minutes",
  diagnostic: Diagnostic,
): Effect.Effect<A, Diagnostic> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(diagnostic),
    }),
  );
}

/**
 * Finds content files and turns each into a validated document: load →
 * compile fields (with an explicit context) → Zod. Files are processed in
 * parallel; every problem becomes a diagnostic.
 */
export class Collector extends Context.Service<
  Collector,
  {
    readonly discover: (
      project: ResolvedProject,
    ) => Effect.Effect<DiscoverResult>;
    readonly validate: (
      project: ResolvedProject,
      files: readonly SourceFile[],
      session: FieldSession,
      cache: Map<string, CachedDocument>,
      options: ValidateOptions,
    ) => Effect.Effect<ValidateResult>;
  }
>()("@anhur/core/engine/Collector") {
  static readonly layer = Layer.effect(
    Collector,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fieldCache = yield* FieldCache;

      const isDirectory = (target: string) =>
        fs.stat(target).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );

      const statDependency = (file: string): Effect.Effect<CachedDependency> =>
        fs.stat(file).pipe(
          Effect.map((info) => ({
            path: file,
            mtimeMs: Option.match(info.mtime, {
              onNone: () => -1,
              onSome: (date) => date.getTime(),
            }),
            size: Number(info.size),
          })),
          Effect.orElseSucceed(() => ({ path: file, mtimeMs: -1, size: -1 })),
        );

      const statAll = (files: Iterable<string>) =>
        Effect.forEach([...files], statDependency, { concurrency: 8 });

      const dependenciesUnchanged = Effect.fn(
        "Collector.dependenciesUnchanged",
      )(function* (dependencies: readonly CachedDependency[]) {
        const now = yield* statAll(
          dependencies.map((dependency) => dependency.path),
        );
        return now.every(
          (current, index) =>
            current.mtimeMs === dependencies[index]!.mtimeMs &&
            current.size === dependencies[index]!.size,
        );
      });

      const globFiles = Effect.fn("Collector.globFiles")(function* (
        project: ResolvedProject,
        root: string,
        include: readonly string[],
        exclude: readonly string[],
      ) {
        const found = new Set<string>();
        const failures: Diagnostic[] = [];
        for (const pattern of include) {
          const entries = yield* fs
            .glob(pattern, {
              root,
              exclude: [...exclude, ...DISCOVER_EXCLUDE],
            })
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  failures.push(
                    errorDiagnostic(
                      "read-failed",
                      `Could not list "${pattern}" in ${root}: ${error.message}`,
                    ),
                  );
                  return [];
                }),
              ),
            );
          for (const entry of entries) {
            const relative = toPosix(entry);
            if (hasHiddenSegment(relative)) continue;
            const absolute = path.resolve(root, entry);
            if (
              isInside(absolute, project.outputDir) ||
              (project.cacheDir !== undefined &&
                isInside(absolute, project.cacheDir)) ||
              relative.split("/").includes("node_modules")
            ) {
              continue;
            }
            found.add(absolute);
          }
        }
        const files: string[] = [];
        for (const file of found) {
          const info = yield* fs.stat(file).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "File")
            files.push(file);
        }
        files.sort();
        return { files, failures };
      });

      const makeFile = (
        project: ResolvedProject,
        source: ResolvedSource,
        absPath: string,
        idBase: string,
        locale: string | undefined,
        id: string,
      ): SourceFile => {
        const meta: ContentMeta = {
          id,
          filePath: relativeTo(project.projectDir, absPath),
          relativePath: toPosix(path.relative(idBase, absPath)),
          extension: path.extname(absPath),
        };
        if (locale !== undefined) meta.locale = locale;
        return { source, absPath, id, locale, meta };
      };

      const discoverCollection = Effect.fn("Collector.discoverCollection")(
        function* (
          project: ResolvedProject,
          source: Extract<ResolvedSource, { kind: "collection" }>,
        ) {
          const diagnostics: Diagnostic[] = [];
          const files: SourceFile[] = [];
          if (!(yield* isDirectory(source.root))) {
            diagnostics.push(
              errorDiagnostic(
                "source-missing",
                `Collection "${source.name}" folder does not exist: ${relativeTo(project.projectDir, source.root)}`,
                {
                  source: source.name,
                  hint: "Create the folder or fix directory in defineCollection().",
                },
              ),
            );
            return { files, diagnostics };
          }
          const localeNames: readonly string[] = source.localized
            ? (project.localization?.locales ?? [])
            : [];
          const locales: readonly (string | undefined)[] = source.localized
            ? localeNames
            : [undefined];
          if (source.localized) {
            const entries = yield* fs
              .readDirectory(source.root)
              .pipe(Effect.orElseSucceed((): string[] => []));
            const stray = entries.filter(
              (entry) => !entry.startsWith(".") && !localeNames.includes(entry),
            );
            if (stray.length > 0) {
              diagnostics.push(
                warningDiagnostic(
                  "source-missing",
                  `Collection "${source.name}" is localized; these entries are not inside a locale folder and are ignored: ${stray.slice(0, 10).join(", ")}`,
                  {
                    source: source.name,
                    hint: `Move files into ${localeNames.map((locale) => `${locale}/`).join(", ")} or set localized: false.`,
                  },
                ),
              );
            }
          }
          const seen = new Map<string, string>();
          for (const locale of locales) {
            const base =
              locale === undefined
                ? source.root
                : path.join(source.root, locale);
            if (locale !== undefined && !(yield* isDirectory(base))) continue;
            const { files: found, failures } = yield* globFiles(
              project,
              base,
              source.include,
              source.exclude,
            );
            diagnostics.push(
              ...failures.map((failure) => ({
                ...failure,
                source: source.name,
              })),
            );
            for (const absPath of found) {
              // NFC: macOS / some editors write decomposed names, references are typed composed.
              const id = stripExtension(
                toPosix(path.relative(base, absPath)),
              ).normalize("NFC");
              const key = `${locale ?? ""}\u0000${id.toLowerCase()}`;
              const previous = seen.get(key);
              if (previous !== undefined) {
                diagnostics.push(
                  errorDiagnostic(
                    "duplicate-id",
                    `"${relativeTo(project.projectDir, absPath)}" and "${relativeTo(project.projectDir, previous)}" both map to the document id "${id}"${locale ? ` (${locale})` : ""}.`,
                    {
                      file: absPath,
                      source: source.name,
                      hint: "Ids come from the path without extension, compared case-insensitively. Rename one file.",
                    },
                  ),
                );
                continue;
              }
              seen.set(key, absPath);
              files.push(
                makeFile(project, source, absPath, source.root, locale, id),
              );
            }
          }
          return { files, diagnostics };
        },
      );

      const discoverSingleton = Effect.fn("Collector.discoverSingleton")(
        function* (
          project: ResolvedProject,
          source: Extract<ResolvedSource, { kind: "singleton" }>,
        ) {
          const diagnostics: Diagnostic[] = [];
          const files: SourceFile[] = [];
          const optional = source.definition.optional === true;
          if (!source.localized) {
            const filePath = source.filePath!;
            const info = yield* fs.stat(filePath).pipe(Effect.option);
            if (Option.isNone(info) || info.value.type !== "File") {
              if (!optional) {
                diagnostics.push(
                  errorDiagnostic(
                    "singleton-missing",
                    `Singleton "${source.name}" file not found: ${relativeTo(project.projectDir, filePath)}`,
                    {
                      source: source.name,
                      hint: "Create the file, fix filePath, or set optional: true.",
                    },
                  ),
                );
              }
              return { files, diagnostics };
            }
            files.push(
              makeFile(
                project,
                source,
                filePath,
                path.dirname(filePath),
                undefined,
                source.name,
              ),
            );
            return { files, diagnostics };
          }
          const localization = project.localization!;
          for (const locale of localization.locales) {
            const base = path.join(source.root, locale);
            const found = (yield* isDirectory(base))
              ? (yield* globFiles(project, base, source.include, [])).files
              : [];
            if (found.length === 0) {
              if (locale === localization.defaultLocale && !optional) {
                diagnostics.push(
                  errorDiagnostic(
                    "singleton-missing",
                    `Singleton "${source.name}" has no file for the default locale "${locale}" in ${relativeTo(project.projectDir, base)} (include: ${source.include.join(", ")}).`,
                    {
                      source: source.name,
                      hint: "Add the file or set optional: true.",
                    },
                  ),
                );
              }
              continue;
            }
            if (found.length > 1) {
              diagnostics.push(
                errorDiagnostic(
                  "singleton-ambiguous",
                  `Singleton "${source.name}" matches several files for "${locale}": ${found.map((file) => relativeTo(project.projectDir, file)).join(", ")}`,
                  {
                    source: source.name,
                    hint: "Keep one file per locale or narrow include.",
                  },
                ),
              );
              continue;
            }
            files.push(
              makeFile(
                project,
                source,
                found[0]!,
                source.root,
                locale,
                source.name,
              ),
            );
          }
          return { files, diagnostics };
        },
      );

      const discover = Effect.fn("Collector.discover")(function* (
        project: ResolvedProject,
      ) {
        const results = yield* Effect.forEach(
          project.sources,
          (source) =>
            source.kind === "collection"
              ? discoverCollection(project, source)
              : discoverSingleton(project, source),
          { concurrency: 4 },
        );
        return {
          files: results.flatMap((result) => result.files),
          diagnostics: results.flatMap((result) => result.diagnostics),
        };
      });

      const loadFile = Effect.fn("Collector.loadFile")(function* (
        project: ResolvedProject,
        file: SourceFile,
        raw: string,
      ) {
        const loader = findLoader(file.absPath, [
          ...project.loaders,
          ...builtinLoaders,
        ]);
        if (!loader) {
          return yield* Effect.fail(
            errorDiagnostic(
              "loader-missing",
              `No loader reads "${file.meta.extension}" files.`,
              {
                file: file.absPath,
                source: file.source.name,
                hint: "Narrow include to .md/.mdx/.yml/.yaml/.json, or add a loader.",
              },
            ),
          );
        }
        const loaded: LoadedFile = yield* withTimeout(
          Effect.tryPromise({
            try: async () => loader.load({ path: file.absPath, raw }),
            catch: (cause) =>
              errorDiagnostic(
                "loader-failed",
                `${loader.name} loader failed: ${messageOf(cause)}`,
                {
                  file: file.absPath,
                  source: file.source.name,
                  cause,
                },
              ),
          }),
          "1 minute",
          errorDiagnostic(
            "loader-failed",
            `${loader.name} loader did not finish within ${LOAD_TIMEOUT}.`,
            {
              file: file.absPath,
            },
          ),
        );
        if (!Predicate.isObject(loaded) || !isPlainObject(loaded.data)) {
          return yield* Effect.fail(
            errorDiagnostic(
              "loader-failed",
              `${loader.name} loader must return { data: object, body?: string }.`,
              {
                file: file.absPath,
              },
            ),
          );
        }
        const problem = findNonPlainData(loaded.data);
        if (problem) {
          return yield* Effect.fail(
            errorDiagnostic(
              "loader-failed",
              `${loader.name} loader returned data that ${problem.message}.`,
              { file: file.absPath, fieldPath: problem.fieldPath },
            ),
          );
        }
        return loaded;
      });

      const compileField = Effect.fn("Collector.compileField")(function* (
        project: ResolvedProject,
        session: FieldSession,
        file: SourceFile,
        body: string | undefined,
        occurrence: FieldOccurrence & { readonly spec: CompileFieldSpec },
        recorder: EffectRecorder,
        cacheKeys: Set<string>,
        options: ValidateOptions,
      ) {
        const spec = occurrence.spec;
        const fieldRecorder = createEffectRecorder();
        const context = createFieldContext(
          session,
          file,
          body,
          occurrence.path,
          fieldRecorder,
        );
        const fail = (message: string, cause?: unknown) =>
          errorDiagnostic("field-failed", `${spec.kind}: ${message}`, {
            file: file.absPath,
            source: file.source.name,
            fieldPath: occurrence.path,
            cause,
          });
        const merge = () => {
          for (const [key, asset] of fieldRecorder.assets)
            recorder.assets.set(key, asset);
          for (const dependency of fieldRecorder.dependencies)
            recorder.dependencies.add(dependency);
          recorder.warnings.push(...fieldRecorder.warnings);
        };

        let cacheKey: string | undefined;
        const cacheSpec = spec.cache;
        if (cacheSpec && project.cacheDir) {
          const plugin = spec.requires
            ? project.plugins.find(
                (candidate) => candidate.name === spec.requires,
              )
            : undefined;
          cacheKey = fingerprint([
            CORE_VERSION,
            spec.kind,
            cacheSpec.version,
            plugin?.version ?? "",
            cacheSpec.key(context),
            occurrence.value,
            occurrence.path,
            body ?? null,
            file.meta,
            project.mode,
            session.publicBase ?? null,
          ]);
          const hit = yield* fieldCache.read(project.cacheDir, cacheKey);
          if (
            Option.isSome(hit) &&
            (yield* dependenciesUnchanged(hit.value.dependencies))
          ) {
            const entry = hit.value;
            const replayed = yield* withTimeout(
              Effect.tryPromise({
                try: async () => {
                  for (const asset of entry.assets) {
                    const again = await emitAssetFile(
                      session,
                      asset.sourcePath,
                      fieldRecorder,
                    );
                    if (again.hash !== asset.hash) return false;
                  }
                  for (const dependency of entry.dependencies) {
                    fieldRecorder.dependencies.add(dependency.path);
                  }
                  fieldRecorder.warnings.push(...entry.warnings);
                  return true;
                },
                catch: () => fail("cache replay failed"),
              }),
              "1 minute",
              fail(`cache replay did not finish within ${LOAD_TIMEOUT}`),
            ).pipe(Effect.orElseSucceed(() => false));
            if (replayed) {
              merge();
              cacheKeys.add(cacheKey);
              return entry.value;
            }
            fieldRecorder.assets.clear();
            fieldRecorder.dependencies.clear();
            fieldRecorder.warnings.length = 0;
          }
        }

        const value = yield* withTimeout(
          Effect.tryPromise({
            try: async (): Promise<DocumentValue> =>
              spec.compile(occurrence.value, context),
            catch: (cause) => fail(messageOf(cause), cause),
          }),
          "5 minutes",
          fail(`did not finish within ${FIELD_TIMEOUT}`),
        );
        merge();
        // Values the cache cannot round-trip (class instances) are not cached;
        // validation reports them with the field path.
        if (cacheKey !== undefined && project.cacheDir && canCache(value)) {
          if (!options.dryRun) {
            const dependencies = yield* statAll(fieldRecorder.dependencies);
            yield* fieldCache.write(project.cacheDir, cacheKey, {
              value,
              assets: [...fieldRecorder.assets.values()].map((asset) => ({
                sourcePath: asset.sourcePath,
                hash: asset.hash,
              })),
              dependencies,
              warnings: [...fieldRecorder.warnings],
            });
          }
          cacheKeys.add(cacheKey);
        }
        return value;
      });

      const validateFile = Effect.fn("Collector.validateFile")(function* (
        project: ResolvedProject,
        file: SourceFile,
        session: FieldSession,
        cache: Map<string, CachedDocument>,
        options: ValidateOptions,
      ) {
        const raw = yield* fs.readFileString(file.absPath).pipe(
          Effect.mapError((error) =>
            errorDiagnostic(
              "read-failed",
              `Could not read the file: ${error.message}`,
              {
                file: file.absPath,
                source: file.source.name,
              },
            ),
          ),
        );
        const hash = sha256(raw);
        const cacheKey = documentCacheKey(file);
        const cached = cache.get(cacheKey);
        // A failed validation must not leave an older result to be reused later.
        cache.delete(cacheKey);
        if (
          cached &&
          cached.hash === hash &&
          cached.projectFingerprint === project.fingerprint &&
          cached.publicBase === session.publicBase &&
          cached.document.file.id === file.id &&
          cached.document.file.locale === file.locale
        ) {
          const unchanged = yield* dependenciesUnchanged(cached.dependencies);
          if (unchanged) {
            // Rebind to this build's source objects (a reloaded config creates new ones).
            const document: ValidatedDocument = { ...cached.document, file };
            cache.set(cacheKey, { ...cached, document });
            return { document, warnings: cached.warnings };
          }
        }

        const loaded = yield* loadFile(project, file, raw);
        const input: DocumentFields = structuredClone(loaded.data);
        const schema: z.core.$ZodType = file.source.definition.schema;
        const recorder = createEffectRecorder();
        const cacheKeys = new Set<string>();
        const occurrences = walkInput(schema, input).filter(
          (
            occurrence,
          ): occurrence is FieldOccurrence & {
            readonly spec: CompileFieldSpec;
          } =>
            occurrence.spec.type === "compile" &&
            (occurrence.present || occurrence.spec.whenAbsent === "compile"),
        );
        const compiled = yield* Effect.forEach(
          occurrences,
          (occurrence) =>
            compileField(
              project,
              session,
              file,
              loaded.body,
              occurrence,
              recorder,
              cacheKeys,
              options,
            ).pipe(
              Effect.map((value) => ({ ok: true as const, occurrence, value })),
              Effect.catch((diagnostic) =>
                Effect.succeed({ ok: false as const, diagnostic }),
              ),
            ),
          { concurrency: FIELD_CONCURRENCY },
        );
        const fieldDiagnostics: Diagnostic[] = [];
        for (const result of compiled) {
          if (!result.ok) {
            fieldDiagnostics.push(result.diagnostic);
            continue;
          }
          writePath(input, result.occurrence.path, result.value);
        }
        if (fieldDiagnostics.length > 0) {
          return yield* Effect.fail(fieldDiagnostics);
        }

        const parsed = yield* withTimeout(
          Effect.tryPromise({
            try: () => file.source.definition.schema.safeParseAsync(input),
            catch: (cause) =>
              errorDiagnostic(
                "validation-failed",
                `Schema threw: ${messageOf(cause)}`,
                {
                  file: file.absPath,
                  source: file.source.name,
                  cause,
                },
              ),
          }),
          "5 minutes",
          errorDiagnostic(
            "validation-failed",
            `Validation did not finish within ${VALIDATE_TIMEOUT}.`,
            {
              file: file.absPath,
            },
          ),
        ).pipe(Effect.mapError((diagnostic) => [diagnostic]));
        if (!parsed.success) {
          return yield* Effect.fail(
            parsed.error.issues.map((issue) =>
              errorDiagnostic("validation-failed", issue.message, {
                file: file.absPath,
                source: file.source.name,
                fieldPath: issuePath(issue.path),
              }),
            ),
          );
        }
        const data: unknown = parsed.data;
        if (!isPlainObject(data)) {
          return yield* Effect.fail([
            errorDiagnostic(
              "validation-failed",
              "The schema must produce an object.",
              {
                file: file.absPath,
                source: file.source.name,
              },
            ),
          ]);
        }
        const problem = findNonPlainData(data);
        if (problem) {
          return yield* Effect.fail([
            errorDiagnostic(
              "validation-failed",
              `The schema output ${problem.message}.`,
              {
                file: file.absPath,
                source: file.source.name,
                fieldPath: problem.fieldPath,
                hint: "Return plain data from .transform() and custom fields (for example url.href instead of a URL).",
              },
            ),
          ]);
        }
        const document: ValidatedDocument = {
          file,
          hash,
          // `draft: true` in the file counts even when the schema does not declare `draft`.
          draft: loaded.data.draft === true || data.draft === true,
          data,
          effects: {
            assets: [...recorder.assets.values()],
            dependencies: [...recorder.dependencies],
            cacheKeys: [...cacheKeys],
          },
        };
        const dependencies = yield* statAll([
          ...recorder.dependencies,
          ...recorder.assets.keys(),
        ]);
        const warnings = recorder.warnings.map((message) =>
          warningDiagnostic("field-failed", message, {
            file: file.absPath,
            source: file.source.name,
          }),
        );
        cache.set(cacheKey, {
          hash,
          projectFingerprint: project.fingerprint,
          publicBase: session.publicBase,
          dependencies,
          document,
          warnings,
        });
        return { document, warnings };
      });

      const validate = Effect.fn("Collector.validate")(function* (
        project: ResolvedProject,
        files: readonly SourceFile[],
        session: FieldSession,
        cache: Map<string, CachedDocument>,
        options: ValidateOptions,
      ) {
        const live = new Set(files.map(documentCacheKey));
        for (const key of cache.keys()) {
          if (!live.has(key)) cache.delete(key);
        }
        const results = yield* Effect.forEach(
          files,
          (file) =>
            validateFile(project, file, session, cache, options).pipe(
              Effect.map((result) => ({ ok: true as const, ...result })),
              Effect.catch((failure) =>
                Effect.succeed({
                  ok: false as const,
                  diagnostics: Array.isArray(failure) ? failure : [failure],
                }),
              ),
            ),
          { concurrency: FILE_CONCURRENCY },
        );
        const documents: ValidatedDocument[] = [];
        const diagnostics: Diagnostic[] = [];
        for (const result of results) {
          if (result.ok) {
            documents.push(result.document);
            diagnostics.push(...result.warnings);
          } else {
            diagnostics.push(...result.diagnostics);
          }
        }
        return { documents, diagnostics };
      });

      return Collector.of({ discover, validate });
    }),
  );
}
