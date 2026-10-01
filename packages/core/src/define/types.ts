import type { z } from "zod";
import type {
  ContentMeta,
  DocumentFields,
  DocumentWithMeta,
} from "../document";
import type { Loader, PluginInput } from "../plugin/types";

/**
 * Any Zod schema usable as a content schema. The root must produce a plain
 * object; the engine reports a `validation-failed` diagnostic otherwise.
 */
export type ContentSchema = z.ZodType;

/** Output type of a content schema. */
export type SchemaOutput<TSchema extends ContentSchema> = z.output<TSchema>;

export type FolderLocalization<
  TLocales extends readonly string[] = readonly string[],
> = {
  /** Locales live in folders: `{directory}/{locale}/…`. */
  readonly strategy: "folder";
  readonly locales: TLocales;
  readonly defaultLocale: TLocales[number];
};

export type Localization = FolderLocalization;

/**
 * How a collection (or localized singleton) is emitted.
 *
 * - `light` — list without heavy fields + per-document modules + async getter (default)
 * - `full` — list with every field; no per-document modules or getter
 * - `list-only` — list with `listOmit` applied; no per-document modules or getter
 */
export type GenerateSplit = "light" | "full" | "list-only";

/** Stable sort for a generated list. */
export type ListSort = {
  /** Top-level document field to sort by. */
  readonly by: string;
  readonly order?: "asc" | "desc";
};

/** Codegen options for a collection. */
export type CollectionGenerateOptions = {
  /** List export name. Default: `allPosts` for `posts`. */
  readonly listName?: string;
  /** Async getter name. Default: `get${typeName}`. */
  readonly getterName?: string;
  /** Plural array type alias. Default: `Posts`. */
  readonly arrayTypeName?: string;
  /** Light list item type name. Default: `PostListItem`. */
  readonly listItemTypeName?: string;
  /** Module split. Default: `light`. */
  readonly split?: GenerateSplit;
  /** Keys left out of the light list. Default: `["body"]`. Ignored for `full`. */
  readonly listOmit?: readonly string[];
  /**
   * Extra string fields the getter accepts besides `id`. Default: `["slug"]`
   * when the schema has a `slug` field, otherwise `[]`.
   */
  readonly lookupBy?: readonly string[];
  /** Emit `export type PostId = "…" | …`. Default: false. */
  readonly emitIds?: boolean;
  /** Emit `export type PostSlug = "…" | …`. Default: false. */
  readonly emitSlugs?: boolean;
  /** Sort the generated list. */
  readonly listSort?: ListSort;
};

/** Codegen options for a singleton. */
export type SingletonGenerateOptions = {
  /** Export name. Default: camelCase `name`. */
  readonly exportName?: string;
  /** Async getter name. Default: `get${TypeName}`. */
  readonly getterName?: string;
  /** All-locales array export. Default: `${exportName}All`. */
  readonly variantsName?: string;
  /**
   * `light` — per-locale modules + getter (default).
   * `full` / `list-only` — the export (+ variants) only.
   */
  readonly split?: GenerateSplit;
  /** Emit the all-locales array when localized. Default: true. */
  readonly emitAll?: boolean;
};

/** Second argument of `transform`. */
export type TransformContext = {
  /**
   * Validated documents of another source (before their own `transform`,
   * references unresolved, drafts removed). Same result in every transform,
   * whatever the source order.
   */
  readonly documents: <TSource extends AnyContent>(
    source: TSource | TSource["name"],
  ) => SchemaDocument<TSource>[];
  /** Drop this document from the output. Return the result of `skip()`. */
  readonly skip: (reason?: string) => SkippedSignal;
};

/** Marker key of `ctx.skip()` results (shared across module copies). */
export const skippedKey: unique symbol = Symbol.for("anhur.skipped");

/** Returned by `ctx.skip()` to drop a document. */
export type SkippedSignal = {
  readonly [skippedKey]: true;
  readonly reason: string | undefined;
};

/** A document as seen by hooks and plugins: data plus `_meta`. */
export type TransformDocument = DocumentFields & { _meta: ContentMeta };

/** Snapshot passed to `prepare` / `complete` / `onSuccess`. */
export type BuiltContentSnapshot = {
  readonly name: string;
  readonly type: "collection" | "singleton";
  /** Mutable in `prepare`; read-only afterwards. */
  documents: TransformDocument[];
};

export type PrepareHook = (
  sources: BuiltContentSnapshot[],
) => void | Promise<void>;

/** Paths passed to `complete`. */
export type CompleteContext = {
  /** Directory of the config file. */
  readonly projectDir: string;
  /** Final generated output directory (already published). */
  readonly outputDir: string;
};

export type CompleteHook = (
  sources: readonly BuiltContentSnapshot[],
  context: CompleteContext,
) => void | Promise<void>;

export type CollectionOnSuccess = (
  documents: readonly TransformDocument[],
) => void | Promise<void>;

/** Receives every locale variant (one entry when monolingual). */
export type SingletonOnSuccess = (
  documents: readonly TransformDocument[],
) => void | Promise<void>;

/** Transform function as stored on a definition. */
export type DocumentTransform = (
  document: TransformDocument,
  context: TransformContext,
) => DocumentFields | SkippedSignal | Promise<DocumentFields | SkippedSignal>;

export type CollectionDefinition<
  TName extends string = string,
  TSchema extends ContentSchema = ContentSchema,
  TData = SchemaOutput<TSchema>,
> = {
  readonly type: "collection";
  readonly name: TName;
  readonly typeName: string;
  readonly directory: string;
  readonly include: string | readonly string[];
  readonly exclude?: string | readonly string[];
  readonly schema: TSchema;
  /** `false` keeps this collection monolingual when the project is localized. */
  readonly localized?: boolean;
  readonly transform?: DocumentTransform;
  readonly onSuccess?: CollectionOnSuccess;
  readonly generate?: CollectionGenerateOptions;
  /** Phantom: document data after schema + transform. */
  readonly _data?: TData;
};

export type SingletonDefinition<
  TName extends string = string,
  TSchema extends ContentSchema = ContentSchema,
  TData = SchemaOutput<TSchema>,
> = {
  readonly type: "singleton";
  readonly name: TName;
  readonly typeName: string;
  readonly schema: TSchema;
  readonly localized?: boolean;
  /** Single file (monolingual singletons). */
  readonly filePath?: string;
  /** Root directory with one folder per locale (localized singletons). */
  readonly directory?: string;
  /** File glob inside each locale folder. Default `index.{md,mdx,yml,yaml,json}`. */
  readonly include?: string | readonly string[];
  /** Allow the file (or default-locale file) to be missing. */
  readonly optional?: boolean;
  readonly transform?: DocumentTransform;
  readonly onSuccess?: SingletonOnSuccess;
  readonly generate?: SingletonGenerateOptions;
  readonly _data?: TData;
};

export type AnyCollection = CollectionDefinition<string, ContentSchema, any>;
export type AnySingleton = SingletonDefinition<string, ContentSchema, any>;
export type AnyContent = AnyCollection | AnySingleton;

/** Shared codegen options for views / indexes / groups. */
export type DerivedGenerateOptions = {
  /** Keys left out before `select`. Default: each source's light-list omit. */
  readonly listOmit?: readonly string[];
  /** Sort before `limit` (ignored when `compare` is set). */
  readonly listSort?: ListSort;
  /** Custom comparator; wins over `listSort`. */
  readonly compare?: (a: DocumentFields, b: DocumentFields) => number;
  /** Keep at most this many items (views: whole list; groups: per group). */
  readonly limit?: number;
};

export type ViewGenerateOptions = DerivedGenerateOptions & {
  readonly listName?: string;
  readonly listItemTypeName?: string;
  readonly arrayTypeName?: string;
};

export type IndexGenerateOptions = DerivedGenerateOptions & {
  readonly exportName?: string;
  readonly listItemTypeName?: string;
  readonly recordTypeName?: string;
};

export type GroupGenerateOptions = DerivedGenerateOptions & {
  readonly exportName?: string;
  readonly listItemTypeName?: string;
  readonly groupTypeName?: string;
  readonly arrayTypeName?: string;
};

/** Cross-collection lookups inside `where` / `select` / key callbacks. */
export type ViewContext = {
  readonly documents: (source: AnyContent | string) => TransformDocument[];
};

type DerivedCallback<TResult> = (
  document: any,
  context: ViewContext,
) => TResult;

export type ViewDefinition<TName extends string = string, TData = unknown> = {
  readonly type: "view";
  readonly name: TName;
  readonly typeName: string;
  readonly from: readonly AnyCollection[];
  readonly where?: DerivedCallback<boolean>;
  readonly select?: DerivedCallback<DocumentFields>;
  readonly generate?: ViewGenerateOptions;
  readonly _data?: TData;
};

export type IndexDefinition<TName extends string = string, TData = unknown> = {
  readonly type: "index";
  readonly name: TName;
  readonly typeName: string;
  readonly from: AnyCollection;
  readonly key: string | ((document: any) => string);
  readonly where?: DerivedCallback<boolean>;
  readonly select?: DerivedCallback<DocumentFields>;
  readonly generate?: IndexGenerateOptions;
  readonly _data?: TData;
};

export type GroupDefinition<TName extends string = string, TData = unknown> = {
  readonly type: "group";
  readonly name: TName;
  readonly typeName: string;
  readonly from: AnyCollection;
  readonly by: string | ((document: any) => string);
  readonly where?: DerivedCallback<boolean>;
  readonly select?: DerivedCallback<DocumentFields>;
  readonly generate?: GroupGenerateOptions;
  readonly _data?: TData;
};

export type AnyView = ViewDefinition<string, any>;
export type AnyIndex = IndexDefinition<string, any>;
export type AnyGroup = GroupDefinition<string, any>;
export type AnyDerived = AnyView | AnyIndex | AnyGroup;

/** Full project config (what `defineConfig` returns). */
export type AnhurConfig = {
  readonly content: readonly AnyContent[];
  /** Views, indexes and groups derived from collections. */
  readonly views?: readonly AnyDerived[];
  /** Folder locales inherited by every source unless it sets `localized: false`. */
  readonly localization?: Localization;
  /** Generated output, relative to the config file. Default `.anhur/generated`. */
  readonly outputDir?: string;
  /** Field cache, relative to the config file. Default `.anhur/cache`; `false` disables. */
  readonly cacheDir?: string | false;
  /** Extra loaders, tried before plugin loaders and built-ins. */
  readonly loaders?: readonly Loader[];
  /** Build plugins (`markdown()`, `mdx()`, `assets()`, `orama()`, …). */
  readonly plugins?: readonly PluginInput<readonly AnyContent[]>[];
  /** Runs after transforms and drafts, before references, uniqueness and views are checked. */
  readonly prepare?: PrepareHook;
  /** Runs after output is published. */
  readonly complete?: CompleteHook;
};

/** Schema output + `_meta` (references unresolved), as seen by `transform`. */
export type SchemaDocument<TSource extends AnyContent> = DocumentWithMeta<
  SchemaOutput<TSource["schema"]>
>;
