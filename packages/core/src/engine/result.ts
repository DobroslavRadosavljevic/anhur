import type { Diagnostic } from "../diagnostics";
import type { BuildMode } from "../plugin/types";

/** Options shared by every build entry point. */
export type BuildOptions = {
  /** Directory used to find the config. Default: `process.cwd()`. */
  readonly rootDir?: string;
  /** Config file, absolute or relative to `rootDir`. Default: `anhur.config.{ts,mts,js,mjs}`. */
  readonly configPath?: string;
  /** `build` (default) or `dev`. Plugins use it, e.g. to skip CDN uploads in dev. */
  readonly mode?: BuildMode;
  /**
   * Public URL prefix of the host app (Vite `base`), joined with the assets
   * base for generated URLs.
   */
  readonly publicPathPrefix?: string;
  /** Run every stage but write nothing (`anhur check`). */
  readonly dryRun?: boolean;
};

/** One source in the build summary. */
export type SourceSummary = {
  readonly name: string;
  readonly kind: "collection" | "singleton";
  /** `locale/id` (or `id`) of every document in the output. */
  readonly documents: readonly string[];
};

/** What a host should watch to rebuild. */
export type WatchTargets = {
  /** Folders to watch recursively (content roots). */
  readonly directories: readonly string[];
  /** Single files (config modules, asset sources, field dependencies). */
  readonly files: readonly string[];
  /** Folders whose changes must never trigger a rebuild (Anhur's own output). */
  readonly ignore: readonly string[];
};

/** Asset folders of a build. */
export type BuildAssets = {
  /** Absolute folder assets are copied into, when the plugin has one. */
  readonly dir: string | undefined;
  /** Prefix of generated asset URLs. */
  readonly publicBase: string;
  /** Path prefix for local serving / copying (`undefined` for remote bases). */
  readonly localBase: string | undefined;
  readonly count: number;
};

/**
 * A stage of a build, in the order the stages run: `config`, `discover`,
 * `validate` (load, compile fields, schema), `transform`, `relations`
 * (prepare, references, uniqueness), `views`, `plugins` (generate hooks),
 * `plan` (generated modules), `publish` (write, publish hooks) and
 * `cleanup` (unused cache entries).
 */
export type BuildStage =
  | "config"
  | "discover"
  | "validate"
  | "transform"
  | "relations"
  | "views"
  | "plugins"
  | "plan"
  | "publish"
  | "cleanup";

/** Time one stage of a build took. */
export type StageTiming = {
  readonly stage: BuildStage;
  readonly ms: number;
};

/** Stage times of failed builds, by the error the build failed with. */
const failedTimings = new WeakMap<Error, readonly StageTiming[]>();

/**
 * Remember where the time of a failed build went. The engine calls this
 * with the error a build fails with. Code that replaces that error by
 * another one must call it again with the new error.
 */
export function recordFailedTimings(
  cause: Error,
  timings: readonly StageTiming[],
): void {
  failedTimings.set(cause, timings);
}

/**
 * The stages a build ran before it failed with `cause`, in order. The last
 * one is the stage that failed. `undefined` when no times are known for
 * `cause`.
 */
export function failedTimingsOf(
  cause: unknown,
): readonly StageTiming[] | undefined {
  return cause instanceof Error ? failedTimings.get(cause) : undefined;
}

/** How the documents of a build were made, by count. */
export type DocumentReuse = {
  /** Taken from a cache after one `stat`: the file was not read. */
  readonly unchanged: number;
  /** Taken from a cache after the file was read and its content compared. */
  readonly compared: number;
  /** Loaded, compiled and validated in this build. */
  readonly validated: number;
};

/** A source whose documents are validated in every session, and why. */
export type NotStored = {
  readonly source: string;
  readonly reason: string;
};

/** Outcome of a successful build. */
export type BuildResult = {
  readonly configPath: string;
  readonly projectDir: string;
  readonly outputDir: string;
  readonly mode: BuildMode;
  readonly sources: readonly SourceSummary[];
  readonly documentCount: number;
  /** Absolute paths written (unchanged files are not rewritten). */
  readonly written: readonly string[];
  /** Absolute paths removed. */
  readonly removed: readonly string[];
  readonly assets: BuildAssets | undefined;
  readonly watch: WatchTargets;
  readonly warnings: readonly Diagnostic[];
  /** Log lines from plugins (for example storage upload counts). */
  readonly messages: readonly string[];
  readonly dryRun: boolean;
  /** Where the time went, in the order the stages ran. */
  readonly timings: readonly StageTiming[];
  /** How many documents came from a cache, and how many were validated. */
  readonly reuse: DocumentReuse;
  /**
   * Sources whose documents are not kept on disk although the document
   * store is on (a field or loader that is not pure, a schema without a
   * fingerprint): every new session validates them again. Sources that
   * set `documentCache: false` are not listed.
   */
  readonly notStored: readonly NotStored[];
};
