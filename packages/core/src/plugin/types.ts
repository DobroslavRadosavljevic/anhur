import type {
  ContentMeta,
  DocumentFields,
  DocumentValue,
  FieldPath,
} from "../document";
import type { AnyContent, TransformDocument } from "../define/types";

/** `build` for one-off builds (CLI build, `vite build`), `dev` for watch / dev servers. */
export type BuildMode = "build" | "dev";

/** Parsed file returned by a {@link Loader}. */
export type LoadedFile = {
  /** Structured fields (frontmatter, YAML, JSON). */
  data: DocumentFields;
  /** Markdown / MDX body without frontmatter. */
  body?: string;
};

/** Reads one content file into fields (+ optional body). */
export type Loader = {
  /** Name used in diagnostics. */
  readonly name: string;
  /** Matches file paths (usually by extension). First match wins. */
  readonly test: RegExp;
  readonly load: (file: {
    readonly path: string;
    readonly raw: string;
  }) => LoadedFile | Promise<LoadedFile>;
};

/** How a body / field URL is used. `link` targets may point at other documents. */
export type LinkRole = "image" | "media" | "link";

/** A file copied into the assets directory for this build. */
export type AssetRef = {
  /** Public URL (base + encoded file name), without `?query` / `#hash`. */
  readonly src: string;
  /** Absolute, symlink-resolved source path. */
  readonly sourcePath: string;
  /** Content-hashed output file name (`cover-1a2b3c4d5e6f7a8b.png`). */
  readonly fileName: string;
  /**
   * 16 hex chars of the SHA-256 of the file contents (prefixed with
   * `${version}\0` when the host has a `transformVersion` for the extension).
   */
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
};

/** Result of resolving a URL found in a document. */
export type ResolvedLink =
  /** Absolute URL, root path, `#hash`, `?query`, or another scheme: left unchanged. */
  | { readonly kind: "external"; readonly url: string }
  /** Relative link to another content file or a directory: left unchanged. */
  | { readonly kind: "document"; readonly url: string; readonly path: string }
  /** Relative file copied as an asset; `url` is the rewritten public URL. */
  | { readonly kind: "asset"; readonly url: string; readonly asset: AssetRef };

/** The document a field is compiled for. */
export type FieldDocument = {
  readonly id: string;
  readonly locale?: string;
  /** Collection / singleton name. */
  readonly source: string;
  /** Absolute path of the source file. */
  readonly filePath: string;
  readonly meta: ContentMeta;
};

/**
 * Explicit context passed to field compilers. Replaces ambient globals: every
 * effect a field has (asset copies, file dependencies) goes through here so
 * the engine can cache and replay it.
 */
export type FieldContext = {
  readonly document: FieldDocument;
  /** Path of the field inside the document. */
  readonly fieldPath: FieldPath;
  /** Markdown / MDX body (absent for YAML / JSON files). */
  readonly body: string | undefined;
  /** Directory of the config file; every relative config path resolves from here. */
  readonly projectDir: string;
  readonly mode: BuildMode;
  /**
   * Changes whenever the config file or a local module it imports changes.
   * Include it in `cache.key` when options hold functions: a function's
   * source text does not show the values it closes over.
   */
  readonly configFingerprint: string;
  /** Registered plugin by name. */
  readonly getPlugin: (name: string) => AnhurPlugin | undefined;
  /**
   * Classify a URL found in the document and copy relative files as assets.
   * Fails for missing files, paths outside the allowed roots, and dotfiles.
   */
  readonly resolveLink: (url: string, role: LinkRole) => Promise<ResolvedLink>;
  /** Copy an absolute file as an asset (same checks as {@link resolveLink}). */
  readonly emitAsset: (absolutePath: string) => Promise<AssetRef>;
  /** Rebuild / invalidate the cached value when this file changes. */
  readonly addDependency: (absolutePath: string) => void;
  readonly warn: (message: string) => void;
};

/** Input value of a field as read from the file (before validation). */
export type FieldInput = DocumentValue;

/** Options of a `unique` constraint. */
export type UniqueOptions = {
  /**
   * - `locale` — unique per collection and locale (default for localized sources)
   * - `collection` — unique across all locales of the collection
   * - `project` — unique across every source that uses the same `group`
   */
  readonly scope?: "locale" | "collection" | "project";
  /**
   * Values are compared within a group. Default: the field path, so two
   * unique fields never conflict with each other.
   */
  readonly group?: string;
};

/** A field computed by the engine before Zod validation runs. */
export type CompileFieldSpec = {
  readonly type: "compile";
  /** Short kind used in diagnostics (`markdown`, `image`, `toc`, …). */
  readonly kind: string;
  /** Plugin that must be registered for this field (checked at config load). */
  readonly requires?: string;
  /**
   * What to do when the key is missing from the file:
   * - `skip` — leave it missing (Zod then applies `.optional()` / `.default()`)
   * - `compile` — call `compile` with `undefined` (body-derived fields)
   */
  readonly whenAbsent: "skip" | "compile";
  /** Also enforce uniqueness of the compiled value. */
  readonly unique?: UniqueOptions;
  readonly compile: (
    input: FieldInput,
    context: FieldContext,
  ) => DocumentValue | Promise<DocumentValue>;
  /**
   * Opt into the on-disk cache. `key` returns a fingerprint (see
   * `fingerprint()`) of everything besides the input, body and document
   * that changes the output (options, plugin lists); `version` invalidates
   * old entries (include compiler versions).
   */
  readonly cache?: {
    readonly version: string;
    readonly key: (context: FieldContext) => string;
  };
};

/** `s.reference()` marker: the value stays a string id / slug until the relations pass. */
export type ReferenceFieldSpec = {
  readonly type: "reference";
  readonly collection: string;
  /** `id` (document `_meta.id`) or the name of a string field on the target. */
  readonly by: string;
  readonly embed: boolean;
};

/** `s.unique()` marker, checked after transforms on surviving documents. */
export type UniqueFieldSpec = {
  readonly type: "unique";
  readonly options: UniqueOptions;
};

export type FieldSpec = CompileFieldSpec | ReferenceFieldSpec | UniqueFieldSpec;

/** Snapshot of one content source passed to plugins and hooks. */
export type SourceSnapshot = {
  readonly name: string;
  readonly type: "collection" | "singleton";
  readonly localized: boolean;
  readonly documents: readonly TransformDocument[];
};

/** Context for {@link AnhurPlugin.setup}. Runs once per config load. */
export type PluginSetupContext = {
  readonly projectDir: string;
  readonly mode: BuildMode;
  readonly outputDir: string;
  readonly sources: readonly AnyContent[];
  /** Absolute folders content is read from (for overlap checks). */
  readonly contentRoots: readonly string[];
  readonly locales: readonly string[];
  /** Report a config problem (fails config loading). */
  readonly error: (message: string, hint?: string) => void;
  readonly warn: (message: string) => void;
};

/** A module added to `anhur/generated` by a plugin. */
export type EmittedModule = {
  /** Path under the output directory, POSIX, ending in `.js` (`search.js`). */
  readonly path: string;
  readonly code: string;
  /** Declarations appended to `index.d.ts`. */
  readonly dts?: string;
  /** Named exports re-exported from `index.js`. */
  readonly exports?: readonly string[];
};

/** Context for {@link AnhurPlugin.generate}. Runs after views are resolved. */
export type PluginGenerateContext = {
  readonly projectDir: string;
  readonly outputDir: string;
  readonly mode: BuildMode;
  readonly locales: readonly string[];
  readonly defaultLocale: string | undefined;
  readonly sources: readonly SourceSnapshot[];
  /** Add a module (and optional exports) to the generated output. */
  readonly emitModule: (module: EmittedModule) => void;
  /** Add a raw file to the generated output (path is relative, POSIX). */
  readonly emitFile: (path: string, contents: string) => void;
  readonly warn: (message: string) => void;
};

/** Asset paths shared with publish hooks and hosts. */
export type AssetsInfo = {
  /** Public URL prefix used in generated `src` values (ends with `/`). */
  readonly publicBase: string;
  /**
   * Origin-absolute path prefix used to serve or copy files locally
   * (`undefined` when the base is a remote URL).
   */
  readonly localBase: string | undefined;
};

/** Context for publish hooks. */
export type PluginPublishContext = {
  readonly projectDir: string;
  readonly outputDir: string;
  readonly mode: BuildMode;
  /** Assets referenced by documents that are part of this build. */
  readonly assets: readonly AssetRef[];
  readonly assetsInfo: AssetsInfo | undefined;
  /** Absolute folder assets are copied into (from {@link AssetHost.dir}). */
  readonly assetsDir: string | undefined;
  /** A line for the build log (CLI / Vite). */
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
};

/**
 * Lets a plugin receive asset copies. Exactly one plugin (`@anhur/assets`)
 * may provide it; without it, relative files in documents are rejected.
 */
export type AssetHost = {
  /** Public URL prefix (`/anhur-assets/` or `https://cdn.example.com/x/`). */
  readonly base: string;
  /** Prefix used instead of `base` in `dev` mode (e.g. local files while the CDN is only filled by builds). */
  readonly devBase?: string;
  /**
   * Folder the plugin copies assets into (relative to the config file).
   * Hosts serve it in dev and copy it into the app build.
   */
  readonly dir?: string;
  /**
   * Extra directories assets may be read from (absolute or relative to the
   * config file). Default: the project directory only. Dotfiles, dot-folders
   * and `node_modules` below the matching root are always refused.
   */
  readonly roots?: readonly string[];
  /** Lowercase extensions (`.png`) allowed as assets. Default: any. */
  readonly extensions?: readonly string[];
  /**
   * Version of the change the host makes to files with this extension
   * while copying them (for example an SVG sanitizer), or `undefined` when
   * it copies them as is. It is part of the asset hash: the hash is the
   * SHA-256 of `` `${version}\0` `` followed by the file bytes (only the
   * bytes without a version), so changing the transform gives new output
   * names and stale copies are never reused.
   */
  readonly transformVersion?: (extension: string) => string | undefined;
};

/** A heading of a compiled body, as it appears in the output. */
export type BodyHeading = {
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** The `id` attribute of the heading in the compiled output. */
  readonly id: string;
  /** Text content of the heading (what the id was derived from). */
  readonly text: string;
};

/**
 * Lets a body compiler (`markdown()`, `mdx()`) report the headings of a
 * body exactly as its output has them, so `s.toc()` anchors match the
 * heading ids.
 */
export type HeadingExtractor = {
  /**
   * Fingerprint of everything besides the body that changes the result
   * (options, plugin lists, compiler versions); part of the `s.toc()`
   * cache key.
   */
  readonly key: (context: FieldContext) => string;
  /** Headings (`h1`–`h6`) of `body`, in document order. */
  readonly extract: (
    body: string,
    context: FieldContext,
  ) => Promise<readonly BodyHeading[]>;
};

/**
 * A build plugin. Packages export factories that return one
 * (`markdown()`, `mdx()`, `assets()`, `orama()`). Extra properties are
 * allowed so fields can read their plugin's options through
 * {@link FieldContext.getPlugin}.
 */
export type AnhurPlugin = {
  /** Unique name (`markdown`, `assets`, …). */
  readonly name: string;
  /** Part of cache keys; bump to invalidate cached field output. */
  readonly version?: string;
  /** Extra file loaders, tried before the built-ins. */
  readonly loaders?: readonly Loader[];
  /** Receive asset copies (see {@link AssetHost}). */
  readonly assets?: AssetHost;
  /** Report body headings with their output ids (used by `s.toc()`). */
  readonly headings?: HeadingExtractor;
  /** Validate options against the loaded config. */
  readonly setup?: (context: PluginSetupContext) => void | Promise<void>;
  /** Emit extra generated modules / files. */
  readonly generate?: (context: PluginGenerateContext) => void | Promise<void>;
  /** Runs before generated files are written (asset copy / upload). */
  readonly beforePublish?: (
    context: PluginPublishContext,
  ) => void | Promise<void>;
  /** Runs after generated files are written. */
  readonly afterPublish?: (
    context: PluginPublishContext,
  ) => void | Promise<void>;
};

declare const pluginContentType: unique symbol;
declare const pluginResolverType: unique symbol;

/**
 * Typed plugin entry for `defineConfig({ plugins })`. The generic call
 * signature makes TypeScript infer `TContent` from the sibling `content`
 * array, so plugin options can be checked against collection document types.
 * At runtime it is a function returning the plugin.
 */
export type ContentPlugin<
  TContent extends readonly AnyContent[],
  TName extends string = string,
> = <TResolve>() => AnhurPlugin & {
  readonly name: TName;
  readonly [pluginContentType]: TContent;
  readonly [pluginResolverType]: TResolve;
};

/** Values accepted in `defineConfig({ plugins })`. */
export type PluginInput<TContent extends readonly AnyContent[]> =
  | AnhurPlugin
  | ContentPlugin<TContent>;
