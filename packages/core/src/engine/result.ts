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
};
