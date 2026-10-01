import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { Context, Effect, FileSystem, Layer, Path, Predicate } from "effect";
import {
  errorDiagnostic,
  messageOf,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import type { BuildMode } from "../plugin/types";
import { BuildFailedError, buildFailed } from "./build-failed";
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

/** Relative specifiers of a module's static and dynamic imports. */
function localSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (
      specifier &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      found.push(specifier);
    }
  }
  return found;
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
       * Config file + every relative module it imports, also outside the
       * project folder (`../shared/consts.ts`); installed packages are not
       * followed.
       */
      const collectSources = Effect.fn("ConfigLoader.collectSources")(
        function* (configPath: string) {
          const seen = new Map<string, string>();
          const queue = [configPath];
          while (queue.length > 0) {
            const file = queue.shift()!;
            if (seen.has(file)) continue;
            const text = yield* fs
              .readFileString(file)
              .pipe(Effect.orElseSucceed(() => ""));
            seen.set(file, text);
            if (seen.size > 500) break;
            for (const specifier of localSpecifiers(text)) {
              const resolved = yield* resolveSpecifier(file, specifier);
              if (
                resolved &&
                !resolved.split(path.sep).includes("node_modules")
              ) {
                queue.push(resolved);
              }
            }
          }
          const hash = createHash("sha256");
          for (const [file, text] of [...seen.entries()].sort(([a], [b]) =>
            a < b ? -1 : 1,
          )) {
            hash.update(file).update("\u0000").update(text).update("\u0000");
          }
          return { files: [...seen.keys()], fingerprint: hash.digest("hex") };
        },
      );

      const importConfig = Effect.fn("ConfigLoader.importConfig")(function* (
        configPath: string,
      ) {
        const jiti = createJiti(configPath, {
          interopDefault: true,
          moduleCache: false,
          fsCache: false,
          nativeModules: [
            "@anhur/core",
            "@anhur/assets",
            "@anhur/markdown",
            "@anhur/mdx",
            "@anhur/orama",
          ],
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
