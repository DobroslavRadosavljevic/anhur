import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
} from "effect";
import {
  errorDiagnostic,
  messageOf,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import type { BuildMode } from "../plugin/types";
import { BuildFailedError, buildFailed } from "./build-failed";
import { isSettled } from "./file-signature";
import { resolveProject, type ResolvedProject } from "./resolve";

/** Config file names tried, in order, when no explicit path is given. */
export const CONFIG_FILE_NAMES = [
  "anhur.config.ts",
  "anhur.config.mts",
  "anhur.config.js",
  "anhur.config.mjs",
];

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
/**
 * Type-only imports and exports: they are gone before the module runs, so
 * the package they name may not exist at run time.
 */
const TYPE_ONLY_PATTERN =
  /(?:import|export)\s+type\s+[^'"`;]*?\s+from\s+["'][^"']+["']/g;
/** Packages loaded as they are installed: their versions are part of every cache key. */
const NATIVE_MODULES = [
  "@anhur/core",
  "@anhur/assets",
  "@anhur/markdown",
  "@anhur/mdx",
  "@anhur/orama",
];
/** Lockfiles, in the order they are looked for in each folder. */
const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
];
/** Local modules followed from the config file. A larger graph is not complete. */
const MAX_CONFIG_MODULES = 2000;
const BUILTIN_MODULES = new Set(builtinModules);
const IMPORT_TIMEOUT = "2 minutes";
const SETUP_TIMEOUT = "2 minutes";

export type LoadProjectOptions = {
  /** Directory used to find the config (default: `process.cwd()`). */
  readonly rootDir: string;
  /** Config path, absolute or relative to `rootDir` (default: `anhur.config.ts` and friends). */
  readonly configPath: string | undefined;
  readonly mode: BuildMode;
  /** Reuse this project when the config sources did not change. */
  readonly previous?: LoadedProject;
};

/** A loaded, validated project and the files it was built from. */
export type LoadedProject = {
  readonly project: ResolvedProject;
  /** Config file plus every local module it imports. */
  readonly configFiles: readonly string[];
  readonly warnings: readonly Diagnostic[];
  /** Hash of the config sources this project was loaded from. */
  readonly sourceFingerprint: string;
};

/** The config file and its local imports. */
export type ConfigSources = {
  readonly configPath: string;
  readonly files: readonly string[];
};

/** A module of the config as a session remembers it. */
type ModuleRecord = {
  /** True for a module whose imports are followed; false for the entry file of an installed package. */
  readonly follow: boolean;
  readonly size: number;
  readonly modified: number;
  /** Epoch milliseconds, taken before the file was read. */
  readonly readAt: number;
  /** The text of a followed module; the hash of the bytes of another file. */
  readonly content: string;
  /** Real paths of the modules it imports that are followed. */
  readonly local: readonly string[];
  /** Real paths of the entry files of installed packages it imports. */
  readonly installed: readonly string[];
};

/** Specifiers of a module's static and dynamic imports that exist at run time. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source
    .replace(TYPE_ONLY_PATTERN, "")
    .matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) found.push(specifier);
  }
  return found;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** Node and Bun modules, and the Anhur packages: never followed. */
function isBuiltIn(specifier: string): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return true;
  }
  if (specifier === "bun" || BUILTIN_MODULES.has(specifier)) return true;
  return NATIVE_MODULES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/** Bun's own resolver, which also reads `paths` of a tsconfig. */
function bunResolve(specifier: string, fromDir: string): string | undefined {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (!Predicate.isObject(bun) || !("resolveSync" in bun)) return undefined;
  const resolveSync = bun.resolveSync;
  if (!Predicate.isFunction(resolveSync)) return undefined;
  try {
    const resolved: unknown = Reflect.apply(resolveSync, bun, [
      specifier,
      fromDir,
    ]);
    return Predicate.isString(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads `anhur.config.*` with a fresh jiti instance per load (its own module
 * cache, never the host's `require.cache`), follows local imports for
 * watching, validates the config, and runs plugin `setup` hooks.
 */
export class ConfigLoader extends Context.Service<
  ConfigLoader,
  {
    readonly load: (
      options: LoadProjectOptions,
    ) => Effect.Effect<LoadedProject, BuildFailedError>;
    /** Config path and the local modules it imports, without evaluating it. */
    readonly inspect: (
      options: LoadProjectOptions,
    ) => Effect.Effect<ConfigSources, BuildFailedError>;
  }
>()("@anhur/core/engine/ConfigLoader") {
  static readonly layer = Layer.effect(
    ConfigLoader,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const exists = (file: string) =>
        fs.exists(file).pipe(Effect.orElseSucceed(() => false));

      const findConfig = Effect.fn("ConfigLoader.findConfig")(function* (
        options: LoadProjectOptions,
      ) {
        const candidates =
          options.configPath === undefined
            ? CONFIG_FILE_NAMES.map((name) =>
                path.resolve(options.rootDir, name),
              )
            : [path.resolve(options.rootDir, options.configPath)];
        for (const candidate of candidates) {
          if (yield* exists(candidate)) {
            return yield* fs
              .realPath(candidate)
              .pipe(Effect.orElseSucceed(() => candidate));
          }
        }
        return yield* Effect.fail(
          buildFailed([
            errorDiagnostic(
              "config-not-found",
              `No Anhur config found (looked for ${candidates.join(", ")}).`,
              { hint: "Create anhur.config.ts or pass configPath." },
            ),
          ]),
        );
      });

      const resolveSpecifier = Effect.fn("ConfigLoader.resolveSpecifier")(
        function* (fromFile: string, specifier: string) {
          const base = path.resolve(path.dirname(fromFile), specifier);
          const candidates = [
            base,
            ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
            ...SOURCE_EXTENSIONS.map((extension) =>
              path.join(base, `index${extension}`),
            ),
          ];
          if (/\.(?:m|c)?js$/.test(base)) {
            const stem = base.replace(/\.(?:m|c)?js$/, "");
            candidates.unshift(
              `${stem}.ts`,
              `${stem}.tsx`,
              `${stem}.mts`,
              `${stem}.cts`,
            );
          }
          for (const candidate of candidates) {
            const info = yield* fs.stat(candidate).pipe(Effect.option);
            if (info._tag === "Some" && info.value.type === "File")
              return candidate;
          }
          return undefined;
        },
      );

      /**
       * Where a specifier that is not relative leads: a package `imports`
       * entry (`#cms/notes`), a workspace package, a `paths` alias. Asked
       * the same way the config is loaded (jiti, then Bun), so a specifier
       * that resolves nowhere here cannot be loaded either.
       */
      const resolver = createJiti(import.meta.url, {
        moduleCache: false,
        fsCache: false,
      });
      const resolvePackage = (
        fromFile: string,
        specifier: string,
      ): string | undefined => {
        let resolved: string | undefined;
        try {
          resolved = resolver.esmResolve(specifier, {
            parentURL: pathToFileURL(fromFile).href,
            try: true,
          });
        } catch {
          resolved = undefined;
        }
        resolved ??= bunResolve(specifier, path.dirname(fromFile));
        if (resolved === undefined) return undefined;
        try {
          return resolved.startsWith("file:")
            ? fileURLToPath(resolved)
            : resolved;
        } catch {
          return undefined;
        }
      };

      /** Lockfile hashes by file state: a lockfile is large and seldom changes. */
      const lockfileHashes = new Map<string, string>();

      /**
       * The lockfile nearest to the config: an installed package that
       * changed (an upgrade of a schema package or a remark plugin) has
       * another entry there.
       */
      const findLockfile = Effect.fn("ConfigLoader.findLockfile")(function* (
        configPath: string,
      ) {
        let dir = path.dirname(configPath);
        for (;;) {
          for (const name of LOCKFILE_NAMES) {
            const file = path.join(dir, name);
            const info = yield* fs.stat(file).pipe(Effect.option);
            if (info._tag !== "Some" || info.value.type !== "File") continue;
            const modified =
              info.value.mtime._tag === "Some"
                ? info.value.mtime.value.getTime()
                : 0;
            const state = `${file}\u0000${String(info.value.size)}\u0000${String(modified)}`;
            let hash = lockfileHashes.get(state);
            if (hash === undefined) {
              const bytes = yield* fs
                .readFile(file)
                .pipe(Effect.orElseSucceed(() => new Uint8Array()));
              hash = createHash("sha256").update(bytes).digest("hex");
              lockfileHashes.clear();
              lockfileHashes.set(state, hash);
            }
            return { file, hash };
          }
          const parent = path.dirname(dir);
          if (parent === dir) return undefined;
          dir = parent;
        }
      });

      /**
       * What a session remembers of the modules of the config, so a rebuild
       * looks at each one (a `stat`) and reads none that did not change.
       */
      const modules = new Map<string, ModuleRecord>();
      /** The lockfile the `modules` were resolved with: a new one can change where an import leads. */
      let resolvedWith: string | undefined;

      /** The state of a file now; `undefined` when it is not a file. */
      const fileState = Effect.fn("ConfigLoader.fileState")(function* (
        file: string,
      ) {
        const info = yield* fs.stat(file).pipe(Effect.option);
        if (info._tag !== "Some" || info.value.type !== "File") {
          return undefined;
        }
        return {
          size: Number(info.value.size),
          modified:
            info.value.mtime._tag === "Some"
              ? info.value.mtime.value.getTime()
              : 0,
        };
      });

      /** Where the imports of a module lead. */
      const readImports = Effect.fn("ConfigLoader.readImports")(function* (
        file: string,
        text: string,
      ) {
        const local: string[] = [];
        const installed: string[] = [];
        if (!SOURCE_EXTENSIONS.includes(path.extname(file))) {
          return { local, installed };
        }
        for (const specifier of importSpecifiers(text)) {
          if (isBuiltIn(specifier)) continue;
          const target = isRelative(specifier)
            ? yield* resolveSpecifier(file, specifier)
            : resolvePackage(file, specifier);
          if (target === undefined) continue;
          const real = yield* fs
            .realPath(target)
            .pipe(Effect.orElseSucceed(() => target));
          if (!real.split(path.sep).includes("node_modules")) local.push(real);
          else if (!isRelative(specifier)) installed.push(real);
        }
        return { local, installed };
      });

      /**
       * A module of the config: its text (a hash for the entry file of an
       * installed package, which is not followed) and where its imports
       * lead. Read again only when its size or time changed, or when it
       * was changed in the seconds before it was read last.
       */
      const readModule = Effect.fn("ConfigLoader.readModule")(function* (
        file: string,
        follow: boolean,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const state = yield* fileState(file);
        const known = modules.get(file);
        if (
          known &&
          state &&
          known.follow === follow &&
          known.size === state.size &&
          known.modified === state.modified &&
          isSettled(state.modified, known.readAt)
        ) {
          return known;
        }
        const bytes = state
          ? yield* fs
              .readFile(file)
              .pipe(Effect.orElseSucceed(() => new Uint8Array()))
          : new Uint8Array();
        const text = follow ? new TextDecoder().decode(bytes) : "";
        const imports = follow
          ? yield* readImports(file, text)
          : { local: [], installed: [] };
        const record: ModuleRecord = {
          follow,
          size: state?.size ?? -1,
          modified: state?.modified ?? -1,
          readAt: now,
          content: follow
            ? text
            : createHash("sha256").update(bytes).digest("hex"),
          local: imports.local,
          installed: imports.installed,
        };
        modules.set(file, record);
        return record;
      });

      /**
       * Everything the config is made from: the config file and every
       * module it imports that is not an installed package (relative
       * paths, also outside the project; package `imports`; workspace
       * packages; `paths` aliases), the entry file of each installed
       * package it imports, and the lockfile. `complete` is false when the
       * graph is too large to follow.
       */
      const collectSources = Effect.fn("ConfigLoader.collectSources")(
        function* (configPath: string) {
          const lockfile = yield* findLockfile(configPath);
          if (resolvedWith !== (lockfile?.hash ?? "")) {
            modules.clear();
            resolvedWith = lockfile?.hash ?? "";
          }
          const seen = new Map<string, string>();
          /** Entry files of installed packages: hashed, not followed, not watched. */
          const installed = new Map<string, string>();
          const queue = [configPath];
          let complete = true;
          while (queue.length > 0) {
            const file = queue.shift()!;
            if (seen.has(file)) continue;
            if (seen.size >= MAX_CONFIG_MODULES) {
              complete = false;
              break;
            }
            const record = yield* readModule(file, true);
            seen.set(file, record.content);
            queue.push(...record.local);
            for (const entry of record.installed) {
              if (installed.has(entry)) continue;
              installed.set(entry, (yield* readModule(entry, false)).content);
            }
          }
          // Modules the config no longer reaches are forgotten.
          for (const file of modules.keys()) {
            if (!seen.has(file) && !installed.has(file)) modules.delete(file);
          }
          const hash = createHash("sha256");
          const sorted = <T>(entries: Iterable<readonly [string, T]>) =>
            [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
          for (const [file, text] of sorted(seen.entries())) {
            hash.update(file).update("\u0000").update(text).update("\u0000");
          }
          for (const [file, digest] of sorted(installed.entries())) {
            hash.update(file).update("\u0000").update(digest).update("\u0000");
          }
          hash.update(lockfile ? `lock\u0000${lockfile.hash}` : "no lockfile");
          return {
            files: lockfile
              ? [...seen.keys(), lockfile.file]
              : [...seen.keys()],
            fingerprint: hash.digest("hex"),
            complete,
          };
        },
      );

      const importConfig = Effect.fn("ConfigLoader.importConfig")(function* (
        configPath: string,
      ) {
        const jiti = createJiti(configPath, {
          interopDefault: true,
          moduleCache: false,
          fsCache: false,
          nativeModules: NATIVE_MODULES,
        });
        const imported = yield* Effect.tryPromise({
          try: () => jiti.import(configPath, { default: true }),
          catch: (cause) =>
            buildFailed([
              errorDiagnostic(
                "config-load-failed",
                `Could not load the config: ${messageOf(cause)}`,
                {
                  file: configPath,
                  cause,
                },
              ),
            ]),
        }).pipe(
          Effect.timeoutOrElse({
            duration: IMPORT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                buildFailed([
                  errorDiagnostic(
                    "config-load-failed",
                    `Loading the config did not finish within ${IMPORT_TIMEOUT}.`,
                    {
                      file: configPath,
                    },
                  ),
                ]),
              ),
          }),
        );
        return imported;
      });

      const runSetup = Effect.fn("ConfigLoader.runSetup")(function* (
        project: ResolvedProject,
      ) {
        const diagnostics: Diagnostic[] = [];
        for (const plugin of project.plugins) {
          const setup = plugin.setup;
          if (!setup) continue;
          const pluginLabel = `Plugin "${plugin.name}"`;
          yield* Effect.tryPromise({
            try: async () => {
              await setup({
                projectDir: project.projectDir,
                mode: project.mode,
                outputDir: project.outputDir,
                sources: project.config.content,
                contentRoots: project.sources.map((source) => source.root),
                locales: project.localization?.locales ?? [],
                error: (message, hint) => {
                  diagnostics.push(
                    errorDiagnostic(
                      "plugin-failed",
                      `${pluginLabel}: ${message}`,
                      { hint },
                    ),
                  );
                },
                warn: (message) => {
                  diagnostics.push(
                    warningDiagnostic(
                      "plugin-failed",
                      `${pluginLabel}: ${message}`,
                    ),
                  );
                },
              });
            },
            catch: (cause) =>
              buildFailed([
                errorDiagnostic(
                  "plugin-failed",
                  `${pluginLabel} setup failed: ${messageOf(cause)}`,
                  { cause },
                ),
              ]),
          }).pipe(
            Effect.timeoutOrElse({
              duration: SETUP_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  buildFailed([
                    errorDiagnostic(
                      "plugin-failed",
                      `${pluginLabel} setup did not finish within ${SETUP_TIMEOUT}.`,
                    ),
                  ]),
                ),
            }),
          );
        }
        return diagnostics;
      });

      const load = Effect.fn("ConfigLoader.load")(function* (
        options: LoadProjectOptions,
      ) {
        const configPath = yield* findConfig(options);
        const sources = yield* collectSources(configPath);
        const previous = options.previous;
        if (
          previous &&
          previous.sourceFingerprint === sources.fingerprint &&
          previous.project.configPath === configPath &&
          previous.project.mode === options.mode
        ) {
          return previous;
        }
        const imported = yield* importConfig(configPath);
        const config =
          Predicate.isObject(imported) && "default" in imported
            ? imported.default
            : imported;
        const resolved = resolveProject(config, {
          configPath,
          mode: options.mode,
          sourceFingerprint: sources.fingerprint,
          sourcesComplete: sources.complete,
        });
        if (!resolved.project) {
          return yield* Effect.fail(
            buildFailed(
              resolved.diagnostics.map((diagnostic) =>
                diagnostic.file
                  ? diagnostic
                  : { ...diagnostic, file: configPath },
              ),
            ),
          );
        }
        const setupDiagnostics = yield* runSetup(resolved.project);
        const all = [...resolved.diagnostics, ...setupDiagnostics];
        if (all.some((diagnostic) => diagnostic.severity === "error")) {
          return yield* Effect.fail(buildFailed(all));
        }
        return {
          project: resolved.project,
          configFiles: sources.files,
          warnings: all,
          sourceFingerprint: sources.fingerprint,
        };
      });

      const inspect = Effect.fn("ConfigLoader.inspect")(function* (
        options: LoadProjectOptions,
      ) {
        const configPath = yield* findConfig(options);
        const sources = yield* collectSources(configPath);
        return { configPath, files: sources.files };
      });

      return ConfigLoader.of({ load, inspect });
    }),
  );
}
