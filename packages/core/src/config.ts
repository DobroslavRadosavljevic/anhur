import pluralize from "pluralize";
import type { z } from "zod";
import type { ProcessorPlugin } from "./processors";
import type { Loader } from "./loaders/types";
import type { DocumentTransform, TransformContext } from "./transform-types";
import type { SkippedSignal } from "./skip";

export type { DocumentTransform, TransformContext } from "./transform-types";

export type ContentMeta = {
  /** Logical document id (path under the locale folder, without extension). */
  id: string;
  /**
   * Path to the source file.
   * During collect/build this is absolute (for errors/logs).
   * Generated modules rewrite it to a path relative to the project root.
   */
  filePath: string;
  /** Path relative to the content source root (collection/singleton directory). */
  relativePath: string;
  /** File extension including the dot (e.g. `.mdx`). */
  extension: string;
  /** Present when localization is enabled for this source. */
  locale?: string;
};

export type FolderLocalization<
  TLocales extends readonly string[] = readonly string[],
> = {
  strategy: "folder";
  locales: TLocales;
  defaultLocale: TLocales[number];
};

export type Localization = FolderLocalization;

export type ContentSchema = z.ZodType<any, any, any>;

type SchemaOutput<TSchema extends ContentSchema> = z.infer<TSchema>;

/**
 * How collection (and localized singleton) modules are split.
 *
 * - `light` — list omits heavy fields; full docs via modules + getter (default)
 * - `full` — every field on the list; no per-doc modules or getter
 * - `list-only` — list with omit rules; no per-doc modules or getter
 */
export type GenerateSplit = "light" | "full" | "list-only";

/** Stable sort for a generated collection list. */
export type ListSort = {
  /** Top-level document field to sort by. */
  by: string;
  order?: "asc" | "desc";
};

/**
 * Per-collection codegen knobs (export names, split mode, lookups, literals).
 */
export type CollectionGenerateOptions = {
  /** List export name. Default: `allPosts` from `name`. */
  listName?: string;
  /**
   * Async getter name. Default: `get${typeName}` (e.g. `getPost`, `getUseCase`).
   * Uses the resolved document `typeName`, not a second pass over `name`.
   */
  getterName?: string;
  /** Plural array type alias. Default: `Posts`. */
  arrayTypeName?: string;
  /** Light list item type name. Default: `PostListItem`. */
  listItemTypeName?: string;
  /** Module split strategy. Default: `light`. */
  split?: GenerateSplit;
  /**
   * Keys omitted from the light list. Overrides top-level `listOmit` when set.
   * Ignored when `split` is `full`.
   */
  listOmit?: readonly string[];
  /**
   * Extra document fields registered in the getter map (in addition to `_meta.id`).
   * Default: `["slug"]`.
   */
  lookupBy?: readonly string[];
  /** Emit `export type PostId = "…" | …`. Default: false. */
  emitIds?: boolean;
  /** Emit `export type PostSlug = "…" | …` from `slug` values. Default: false. */
  emitSlugs?: boolean;
  /** Sort the generated list before writing. */
  listSort?: ListSort;
};

/**
 * Per-singleton codegen knobs (export names, getter, locale variants).
 */
export type SingletonGenerateOptions = {
  /** Primary const export name. Default: source `name`. */
  exportName?: string;
  /** Async getter name. Default: `getSettings` from `name`. */
  getterName?: string;
  /** All-locales array name. Default: `${name}All`. */
  variantsName?: string;
  /**
   * `light` — per-locale modules + getter (default).
   * `full` / `list-only` — primary (+ optional All) only; no getter/modules.
   */
  split?: GenerateSplit;
  /** Emit the all-locales array when localized. Default: true. */
  emitAll?: boolean;
};

export type CollectionDefinition<
  TName extends string = string,
  TSchema extends ContentSchema = ContentSchema,
  TData = SchemaOutput<TSchema>,
> = {
  type: "collection";
  name: TName;
  typeName: string;
  directory: string;
  include: string | string[];
  exclude?: string | string[];
  schema: TSchema;
  /**
   * When `false`, this collection stays monolingual even if the config
   * defines project `localization`. Default: inherit (localized).
   */
  localized?: boolean;
  /**
   * Optional post-validate map (joins, denormalize).
   * Prefer `m.mdx()` / `s.raw()` for body compilation.
   * Second argument is a {@link TransformContext} with `documents()` / `skip()`.
   * Return `ctx.skip()` (or set `draft: true`) to omit a document from output.
   * Extra fields on the return value are included in generated document types.
   */
  transform?: DocumentTransform;
  /**
   * Called after codegen with the final documents for this collection.
   */
  onSuccess?: import("./transform-types").CollectionOnSuccess;
  /**
   * Keys omitted from the light collection index (`allPosts`, …).
   * Prefer `generate.listOmit` for new config. Default: `["body"]`.
   */
  listOmit?: readonly string[];
  /** Codegen / export tweaks for this collection. */
  generate?: CollectionGenerateOptions;
  /** Phantom: document data after schema (+ optional transform). */
  readonly _data?: TData;
};

export type SingletonDefinition<
  TName extends string = string,
  TSchema extends ContentSchema = ContentSchema,
  TData = SchemaOutput<TSchema>,
> = {
  type: "singleton";
  name: TName;
  typeName: string;
  schema: TSchema;
  /**
   * When `false`, this singleton stays monolingual even if the config
   * defines project `localization`. Default: inherit (localized).
   */
  localized?: boolean;
  /**
   * Single file when this source is not localized.
   * Ignored when localized (use `directory` + locale folders).
   */
  filePath?: string;
  /**
   * Root directory. Required when localized.
   * With folder locales: `{directory}/{locale}/index.md(x)` by default.
   */
  directory?: string;
  /**
   * Glob under each locale folder (default `index.{md,mdx}`).
   * Only used when localized.
   */
  include?: string | string[];
  optional?: boolean;
  /**
   * Optional post-validate map (joins, denormalize).
   * Return `ctx.skip()` (or set `draft: true`) to omit from output.
   * Extra fields on the return value are included in generated document types.
   */
  transform?: DocumentTransform;
  /**
   * Called after codegen with the final singleton document (or `undefined`).
   */
  onSuccess?: import("./transform-types").SingletonOnSuccess;
  /** Codegen / export tweaks for this singleton. */
  generate?: SingletonGenerateOptions;
  /** Phantom: document data after schema (+ optional transform). */
  readonly _data?: TData;
};

export type AnyCollection = CollectionDefinition<string, ContentSchema, any>;
export type AnySingleton = SingletonDefinition<string, ContentSchema, any>;
export type AnyContent = AnyCollection | AnySingleton;

/** Shared codegen knobs for views / indexes / groups. */
export type DerivedGenerateOptions = {
  /**
   * Keys omitted before `select` / emit.
   * Default: inherit each source collection’s light-list omit.
   */
  listOmit?: readonly string[];
  /** Sort before limit (ignored when `compare` is set). */
  listSort?: ListSort;
  /** Custom comparator; wins over `listSort`. */
  compare?: (a: Record<string, unknown>, b: Record<string, unknown>) => number;
  /** Keep at most this many items after sort (views: whole list; groups: per group). */
  limit?: number;
};

/** Codegen knobs for list views (`defineView`). */
export type ViewGenerateOptions = DerivedGenerateOptions & {
  /** List export name. Default: `allFeaturedPosts` from `name`. */
  listName?: string;
  /** List item type name. Default: singular PascalCase from `name`. */
  listItemTypeName?: string;
  /** Plural array type alias. Default: PascalCase from `name`. */
  arrayTypeName?: string;
};

/** Codegen knobs for key→item maps (`defineIndex`). */
export type IndexGenerateOptions = DerivedGenerateOptions & {
  /** Export name. Default: the index `name` (e.g. `productBySku`). */
  exportName?: string;
  /** Value type name. Default: singular PascalCase from `name`. */
  listItemTypeName?: string;
  /** `Record<string, Item>` alias. Default: PascalCase from `name`. */
  recordTypeName?: string;
};

/** Codegen knobs for grouped lists (`defineGroup`). */
export type GroupGenerateOptions = DerivedGenerateOptions & {
  /** Export name. Default: the group `name` (e.g. `productsByCategory`). */
  exportName?: string;
  /** Item type name inside each group. Default: singular PascalCase from `name`. */
  listItemTypeName?: string;
  /** `{ key, count, items }` type name. Default: `{TypeName}Group`. */
  groupTypeName?: string;
  /** Array type alias. Default: PascalCase from `name`. */
  arrayTypeName?: string;
};

/**
 * Named list derived from one or more collections (filter / merge).
 * List-only — no getters or per-document modules.
 */
export type ViewDefinition<TName extends string = string, TData = unknown> = {
  type: "view";
  name: TName;
  typeName: string;
  /** Source collections (always normalized to an array). */
  from: readonly AnyCollection[];
  where?: (document: Record<string, unknown>, context: ViewContext) => boolean;
  select?: (
    document: Record<string, unknown>,
    context: ViewContext,
  ) => Record<string, unknown>;
  generate?: ViewGenerateOptions;
  /** Phantom: list item type after `where` / `select`. */
  readonly _data?: TData;
};

/**
 * Keyed map derived from one collection (`Record<key, item>`).
 * Useful for detail routes without a full getter tree.
 */
export type IndexDefinition<TName extends string = string, TData = unknown> = {
  type: "index";
  name: TName;
  typeName: string;
  from: AnyCollection;
  key: string | ((document: Record<string, unknown>) => string);
  where?: (document: Record<string, unknown>, context: ViewContext) => boolean;
  select?: (
    document: Record<string, unknown>,
    context: ViewContext,
  ) => Record<string, unknown>;
  generate?: IndexGenerateOptions;
  readonly _data?: TData;
};

/**
 * Grouped lists derived from one collection (`{ key, count, items }[]`).
 * Useful for facet / SEO landing pages.
 */
export type GroupDefinition<TName extends string = string, TData = unknown> = {
  type: "group";
  name: TName;
  typeName: string;
  from: AnyCollection;
  by: string | ((document: Record<string, unknown>) => string);
  where?: (document: Record<string, unknown>, context: ViewContext) => boolean;
  select?: (
    document: Record<string, unknown>,
    context: ViewContext,
  ) => Record<string, unknown>;
  generate?: GroupGenerateOptions;
  readonly _data?: TData;
};

export type AnyView = ViewDefinition<string, any>;
export type AnyIndex = IndexDefinition<string, any>;
export type AnyGroup = GroupDefinition<string, any>;
export type AnyDerived = AnyView | AnyIndex | AnyGroup;

/** Document shape passed to optional `transform` hooks after validation. */
export type TransformDocument = Record<string, unknown> & {
  _meta: ContentMeta;
};

export type AnhurConfig = {
  content: readonly AnyContent[];
  /**
   * Derived exports: `defineView` lists, `defineIndex` maps, `defineGroup` groups.
   * Built after transforms/`prepare`, from final collection documents.
   */
  views?: readonly AnyDerived[];
  /**
   * Project locale catalog. When set, every source inherits folder locales
   * unless it sets `localized: false`.
   */
  localization?: Localization;
  /** Directory for generated output, relative to config file (default `.anhur/generated`). */
  outputDir?: string;
  /**
   * Disk cache for expensive field compiles (MDX/Markdown).
   * Relative to config file. Default `.anhur/cache`. Set `false` to disable.
   */
  cacheDir?: string | false;
  /** Extra file loaders (matched before built-in matter / yaml / json). */
  loaders?: readonly Loader[];
  /**
   * Opaque processors from packages (`mdx()`, `markdown()`, `assets()`, …).
   * Required when schemas use matching field helpers (`m.mdx()`, `a.image()`, …).
   */
  processors?: readonly ProcessorPlugin[];
  /**
   * Build integrations (`orama()`, custom `defineIntegration`, …).
   * Prefer typed entries returned by package factories.
   */
  integrations?: readonly import("./integrations").IntegrationInput<
    readonly AnyContent[]
  >[];
  /**
   * Runs after transforms (and draft/skip filtering), before codegen.
   * Mutate `sources[].documents` for global joins if needed.
   */
  prepare?: import("./transform-types").PrepareHook;
  /**
   * Runs after codegen, per-source `onSuccess`, and `integrations`.
   * Receives built snapshots and `{ rootDir, outputDir }`.
   */
  complete?: import("./transform-types").CompleteHook;
};

export type DocumentWithMeta<TData> = TData & {
  _meta: ContentMeta;
};

/** Infer document data type (without `_meta`) from a content definition. */
export type InferSchemaData<T> =
  T extends CollectionDefinition<string, ContentSchema, infer TData>
    ? TData
    : T extends SingletonDefinition<string, ContentSchema, infer TData>
      ? TData
      : never;

export type InferDocument<T> = DocumentWithMeta<InferSchemaData<T>>;

/**
 * Cross-collection helpers for view / index / group `where` and `select`.
 * Pass a collection/singleton object to `documents()` for a typed array.
 *
 * When `TContent` is the project content tuple, `documents(source)` remaps
 * `embed: true` fields the same way as {@link GetTypeByName}.
 */
export type ViewContext<
  TContent extends readonly AnyContent[] | undefined = undefined,
> = {
  documents: {
    <C extends AnyContent>(
      source: C,
    ): [TContent] extends [readonly AnyContent[]]
      ? RemapEmbeddedRefs<InferDocument<C>, TContent>[]
      : InferDocument<C>[];
    (source: string): TransformDocument[];
  };
};

export function isSingleton(source: AnyContent): source is AnySingleton {
  return source.type === "singleton";
}

export function isCollection(source: AnyContent): source is AnyCollection {
  return source.type === "collection";
}

export function isView(value: { type: string }): value is AnyView {
  return value.type === "view";
}

export function isIndex(value: { type: string }): value is AnyIndex {
  return value.type === "index";
}

export function isGroup(value: { type: string }): value is AnyGroup {
  return value.type === "group";
}

export function isDerived(value: { type: string }): value is AnyDerived {
  return isView(value) || isIndex(value) || isGroup(value);
}

/** Whether this source uses project localization (inherits unless opted out). */
export function isLocalized(
  config: Pick<AnhurConfig, "localization">,
  source: AnyContent,
): boolean {
  if (!config.localization) return false;
  return source.localized !== false;
}

/** Effective localization for a source, or `undefined` if monolingual. */
export function resolveLocalization(
  config: Pick<AnhurConfig, "localization">,
  source: AnyContent,
): Localization | undefined {
  return isLocalized(config, source) ? config.localization : undefined;
}

export function generateTypeName(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * `Posts` → `Post`, `UseCases` → `UseCase`, `Categories` → `Category`.
 * Uses [pluralize](https://github.com/plurals/pluralize) so irregular plurals
 * stay correct; override with `defineCollection({ typeName })` when needed.
 */
export function singularizePascal(pascal: string): string {
  return pluralize.singular(pascal);
}

/**
 * Default document type name for a collection: singular PascalCase.
 * `posts` → `Post`, `blog-posts` → `BlogPost`, `changelog` → `Changelog`.
 */
export function generateDocumentTypeName(name: string): string {
  return singularizePascal(generateTypeName(name));
}

/** Plural PascalCase alias for a collection (`posts` → `Posts`). */
export function generateCollectionArrayTypeName(
  collectionName: string,
  documentTypeName: string,
): string {
  const fromName = generateTypeName(collectionName);
  if (fromName !== documentTypeName) return fromName;
  return `${documentTypeName}s`;
}

/** `posts` → `allPosts`, `author` → `allAuthors` */
export function collectionConstName(name: string): string {
  const pascal = generateTypeName(name);
  if (pascal.endsWith("s")) {
    return `all${pascal}`;
  }
  return `all${pascal}s`;
}

export function singletonConstName(name: string): string {
  return name;
}

function isZodSchema(schema: unknown): schema is ContentSchema {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParseAsync" in schema &&
    typeof (schema as ContentSchema).safeParseAsync === "function"
  );
}

export type DefineCollectionInput<
  TName extends string,
  TSchema extends ContentSchema,
  TOut = DocumentWithMeta<SchemaOutput<TSchema>>,
> = {
  name: TName;
  typeName?: string;
  directory: string;
  include: string | string[];
  exclude?: string | string[];
  schema: TSchema;
  localized?: boolean;
  transform?: (
    document: DocumentWithMeta<SchemaOutput<TSchema>>,
    context: TransformContext,
  ) => TOut | SkippedSignal | Promise<TOut | SkippedSignal>;
  onSuccess?: import("./transform-types").CollectionOnSuccess;
  /**
   * Keys omitted from the light collection index. Default `["body"]`.
   * Pass `[]` to keep every field on the list export.
   * Prefer `generate.listOmit` when also setting other generate options.
   */
  listOmit?: readonly string[];
  generate?: CollectionGenerateOptions;
};

type DataFromTransformOut<TOut> =
  Exclude<Awaited<TOut>, SkippedSignal> extends infer R
    ? R extends { _meta: ContentMeta }
      ? Omit<R, "_meta">
      : never
    : never;

export function defineCollection<
  TName extends string,
  TSchema extends ContentSchema,
  TOut = DocumentWithMeta<SchemaOutput<TSchema>>,
  const TLocalized extends boolean | undefined = undefined,
>(
  input: DefineCollectionInput<TName, TSchema, TOut> & {
    localized?: TLocalized;
  },
): CollectionDefinition<TName, TSchema, DataFromTransformOut<TOut>> &
  (undefined extends TLocalized ? unknown : { localized: TLocalized }) {
  if (!isZodSchema(input.schema)) {
    throw new Error(
      `Collection "${input.name}" schema must be a Zod schema (use \`schema as s\` from @anhur/core).`,
    );
  }

  return {
    type: "collection",
    name: input.name,
    typeName: input.typeName ?? generateDocumentTypeName(input.name),
    directory: input.directory,
    include: input.include,
    exclude: input.exclude,
    schema: input.schema,
    localized: input.localized,
    transform: input.transform as DocumentTransform | undefined,
    onSuccess: input.onSuccess,
    listOmit: input.listOmit,
    generate: input.generate,
  } as CollectionDefinition<TName, TSchema, DataFromTransformOut<TOut>> &
    (undefined extends TLocalized ? unknown : { localized: TLocalized });
}

export type DefineSingletonInput<
  TName extends string,
  TSchema extends ContentSchema,
  TOut = DocumentWithMeta<SchemaOutput<TSchema>>,
> = {
  name: TName;
  typeName?: string;
  schema: TSchema;
  localized?: boolean;
  filePath?: string;
  directory?: string;
  include?: string | string[];
  optional?: boolean;
  transform?: (
    document: DocumentWithMeta<SchemaOutput<TSchema>>,
    context: TransformContext,
  ) => TOut | SkippedSignal | Promise<TOut | SkippedSignal>;
  onSuccess?: import("./transform-types").SingletonOnSuccess;
  generate?: SingletonGenerateOptions;
};

export function defineSingleton<
  TName extends string,
  TSchema extends ContentSchema,
  TOut = DocumentWithMeta<SchemaOutput<TSchema>>,
  const TLocalized extends boolean | undefined = undefined,
>(
  input: DefineSingletonInput<TName, TSchema, TOut> & {
    localized?: TLocalized;
  },
): SingletonDefinition<TName, TSchema, DataFromTransformOut<TOut>> &
  (undefined extends TLocalized ? unknown : { localized: TLocalized }) {
  if (!isZodSchema(input.schema)) {
    throw new Error(
      `Singleton "${input.name}" schema must be a Zod schema (use \`schema as s\` from @anhur/core).`,
    );
  }

  return {
    type: "singleton",
    name: input.name,
    typeName: input.typeName ?? generateTypeName(input.name),
    schema: input.schema,
    localized: input.localized,
    filePath: input.filePath,
    directory: input.directory,
    include: input.include,
    optional: input.optional,
    transform: input.transform as DocumentTransform | undefined,
    onSuccess: input.onSuccess,
    generate: input.generate,
  } as SingletonDefinition<TName, TSchema, DataFromTransformOut<TOut>> &
    (undefined extends TLocalized ? unknown : { localized: TLocalized });
}

type CollectionMeta<TCollection extends AnyCollection> = TCollection extends {
  localized: false;
}
  ? Omit<ContentMeta, "locale"> & { locale?: undefined }
  : ContentMeta;

type CollectionDocument<TCollection extends AnyCollection> =
  InferSchemaData<TCollection> & {
    _meta: CollectionMeta<TCollection>;
  };

/**
 * Collection document with `embed: true` refs remapped against a content tuple.
 * Pass the same array as `defineConfig({ content })` so `doc.provider.slug` works
 * in `where` / `select` / `by` / `key` callbacks.
 */
export type RemappedCollectionDocument<
  TCollection extends AnyCollection,
  TContent extends readonly AnyContent[],
> = RemapEmbeddedRefs<CollectionDocument<TCollection>, TContent>;

/** Remap when `content` is provided; otherwise keep schema phantoms. */
type ViewSourceDocument<
  TCollection extends AnyCollection,
  TContent extends readonly AnyContent[] | undefined,
> = [TContent] extends [readonly AnyContent[]]
  ? RemappedCollectionDocument<TCollection, TContent>
  : CollectionDocument<TCollection>;

type MultiCollectionDocument<
  TCollections extends readonly AnyCollection[],
  TContent extends readonly AnyContent[] | undefined = undefined,
> = {
  [I in keyof TCollections]: TCollections[I] extends AnyCollection
    ? ViewSourceDocument<TCollections[I], TContent> & {
        collection: TCollections[I]["name"];
      }
    : never;
}[number];

type MultiSelectInput<
  TCollections extends readonly AnyCollection[],
  TContent extends readonly AnyContent[] | undefined = undefined,
> = MultiCollectionDocument<TCollections, TContent>;

/** Top-level document fields whose values are strings (valid index/group keys). */
type StringFieldKeys<T> = {
  [K in keyof Omit<T, "_meta">]-?: Exclude<T[K], undefined> extends string
    ? K
    : never;
}[keyof Omit<T, "_meta">] &
  string;

export type DefineViewSingleInput<
  TName extends string,
  TCollection extends AnyCollection,
  TContent extends readonly AnyContent[] | undefined = undefined,
> = {
  name: TName;
  typeName?: string;
  /**
   * Same content array as `defineConfig({ content })`. Enables remapped
   * `embed: true` fields in `where` / `select` (e.g. `doc.author.slug`).
   */
  content?: TContent;
  from: TCollection;
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  select?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => Record<string, unknown>;
  generate?: ViewGenerateOptions;
};

export type DefineViewMultiInput<
  TName extends string,
  TCollections extends readonly [AnyCollection, ...AnyCollection[]],
  TItem extends Record<string, unknown> = Record<string, unknown>,
  TContent extends readonly AnyContent[] | undefined = undefined,
> = {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollections;
  where?: (
    document: MultiCollectionDocument<TCollections, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  /** Required when merging collections — shared list item shape. */
  select: (
    document: MultiSelectInput<TCollections, TContent>,
    context: ViewContext<TContent>,
  ) => TItem;
  generate?: ViewGenerateOptions;
};

function normalizeViewFrom(
  from: AnyCollection | readonly AnyCollection[],
  label: string,
): AnyCollection[] {
  const sources = Array.isArray(from) ? [...from] : [from];
  if (sources.length === 0) {
    throw new Error(`${label} requires at least one collection in \`from\`.`);
  }
  for (const source of sources) {
    if (!source || source.type !== "collection") {
      throw new Error(
        `${label} \`from\` must reference collection definitions.`,
      );
    }
  }
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) {
      throw new Error(
        `${label} \`from\` lists collection "${source.name}" more than once.`,
      );
    }
    names.add(source.name);
  }
  return sources;
}

/**
 * Single-collection view: type-predicate `where` + `select` (select sees narrowed doc).
 */
export function defineView<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TNarrow extends ViewSourceDocument<TCollection, TContent> =
    ViewSourceDocument<TCollection, TContent>,
  TItem extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  where: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => document is TNarrow;
  select: (document: TNarrow, context: ViewContext<TContent>) => TItem;
  generate?: ViewGenerateOptions;
}): ViewDefinition<TName, TItem>;

/**
 * Single-collection view with optional `select` (item type from select return).
 */
export function defineView<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TItem extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  select: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => TItem;
  generate?: ViewGenerateOptions;
}): ViewDefinition<TName, TItem>;

/**
 * Single-collection view narrowed by a type predicate `where`.
 */
export function defineView<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TNarrow extends ViewSourceDocument<TCollection, TContent> =
    ViewSourceDocument<TCollection, TContent>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  where: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => document is TNarrow;
  generate?: ViewGenerateOptions;
}): ViewDefinition<TName, TNarrow>;

/** Single-collection filtered list view. */
export function defineView<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  generate?: ViewGenerateOptions;
}): ViewDefinition<TName, ViewSourceDocument<TCollection, TContent>>;

/** Multi-collection merged list view (`select` required). */
export function defineView<
  TName extends string,
  TCollections extends readonly [AnyCollection, ...AnyCollection[]],
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TItem extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollections;
  where?: (
    document: MultiCollectionDocument<TCollections, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  select: (
    document: MultiSelectInput<TCollections, TContent>,
    context: ViewContext<TContent>,
  ) => TItem;
  generate?: ViewGenerateOptions;
}): ViewDefinition<TName, TItem>;

export function defineView(input: {
  name: string;
  typeName?: string;
  content?: readonly AnyContent[];
  from: AnyCollection | readonly AnyCollection[];
  where?: (document: any, context: ViewContext) => boolean;
  select?: (document: any, context: ViewContext) => Record<string, unknown>;
  generate?: ViewGenerateOptions;
}): ViewDefinition {
  const from = normalizeViewFrom(input.from, "defineView");
  if (from.length > 1 && input.select == null) {
    throw new Error(
      `View "${input.name}" merges multiple collections and requires select() to define a shared list item shape.`,
    );
  }

  return {
    type: "view",
    name: input.name,
    typeName: input.typeName ?? generateDocumentTypeName(input.name),
    from,
    where: input.where,
    select: input.select,
    generate: input.generate,
  };
}

/** Key→item map from one collection (type-predicate `where` + `select`). */
export function defineIndex<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TNarrow extends ViewSourceDocument<TCollection, TContent> =
    ViewSourceDocument<TCollection, TContent>,
  TItem extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  key:
    | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
    | ((document: TNarrow) => string);
  where: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => document is TNarrow;
  select: (document: TNarrow, context: ViewContext<TContent>) => TItem;
  generate?: IndexGenerateOptions;
}): IndexDefinition<TName, TItem>;

/** Key→item map from one collection (`select` defines value type). */
export function defineIndex<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TItem extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  key:
    | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
    | ((document: ViewSourceDocument<TCollection, TContent>) => string);
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  select: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => TItem;
  generate?: IndexGenerateOptions;
}): IndexDefinition<TName, TItem>;

/** Key→item map narrowed by a type predicate `where`. */
export function defineIndex<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TNarrow extends ViewSourceDocument<TCollection, TContent> =
    ViewSourceDocument<TCollection, TContent>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  key:
    | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
    | ((document: TNarrow) => string);
  where: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => document is TNarrow;
  generate?: IndexGenerateOptions;
}): IndexDefinition<TName, TNarrow>;

/** Key→item map (full light document as value). */
export function defineIndex<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  key:
    | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
    | ((document: ViewSourceDocument<TCollection, TContent>) => string);
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  generate?: IndexGenerateOptions;
}): IndexDefinition<TName, ViewSourceDocument<TCollection, TContent>>;

export function defineIndex(input: {
  name: string;
  typeName?: string;
  content?: readonly AnyContent[];
  from: AnyCollection;
  key: string | ((document: any) => string);
  where?: (document: any, context: ViewContext) => boolean;
  select?: (document: any, context: ViewContext) => Record<string, unknown>;
  generate?: IndexGenerateOptions;
}): IndexDefinition {
  if (!input.from || input.from.type !== "collection") {
    throw new Error("defineIndex `from` must be a collection definition.");
  }

  return {
    type: "index",
    name: input.name,
    typeName: input.typeName ?? generateDocumentTypeName(input.name),
    from: input.from,
    key: input.key as IndexDefinition["key"],
    where: input.where,
    select: input.select,
    generate: input.generate,
  };
}

/** Grouped lists with `select` (item type from select return). */
export function defineGroup<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
  TItem extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  by:
    | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
    | ((document: ViewSourceDocument<TCollection, TContent>) => string);
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  select: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => TItem;
  generate?: GroupGenerateOptions;
}): GroupDefinition<TName, TItem>;

/** Grouped lists (full light document as item). */
export function defineGroup<
  TName extends string,
  TCollection extends AnyCollection,
  const TContent extends readonly AnyContent[] | undefined = undefined,
>(input: {
  name: TName;
  typeName?: string;
  content?: TContent;
  from: TCollection;
  by:
    | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
    | ((document: ViewSourceDocument<TCollection, TContent>) => string);
  where?: (
    document: ViewSourceDocument<TCollection, TContent>,
    context: ViewContext<TContent>,
  ) => boolean;
  generate?: GroupGenerateOptions;
}): GroupDefinition<TName, ViewSourceDocument<TCollection, TContent>>;

export function defineGroup(input: {
  name: string;
  typeName?: string;
  content?: readonly AnyContent[];
  from: AnyCollection;
  by: string | ((document: any) => string);
  where?: (document: any, context: ViewContext) => boolean;
  select?: (document: any, context: ViewContext) => Record<string, unknown>;
  generate?: GroupGenerateOptions;
}): GroupDefinition {
  if (!input.from || input.from.type !== "collection") {
    throw new Error("defineGroup `from` must be a collection definition.");
  }

  return {
    type: "group",
    name: input.name,
    typeName: input.typeName ?? generateDocumentTypeName(input.name),
    from: input.from,
    by: input.by as GroupDefinition["by"],
    where: input.where,
    select: input.select,
    generate: input.generate,
  };
}

/**
 * Bind `defineView` / `defineIndex` / `defineGroup` to a content tuple so
 * `embed: true` fields remap in callbacks without repeating `content` on each call.
 *
 * @example
 * ```ts
 * const content = [providers, proxies] as const;
 * const { defineGroup } = createDerivedHelpers(content);
 * defineGroup({
 *   name: "proxiesByProvider",
 *   from: proxies,
 *   by: (doc) => doc.provider.slug,
 * });
 * ```
 */
export function createDerivedHelpers<
  const TContent extends readonly AnyContent[],
>(content: TContent) {
  return {
    defineView: ((input: Record<string, unknown>) =>
      defineView({ ...input, content } as never)) as unknown as {
      <
        TName extends string,
        TCollection extends AnyCollection,
        TItem extends Record<string, unknown>,
      >(input: {
        name: TName;
        typeName?: string;
        from: TCollection;
        where?: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        select: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => TItem;
        generate?: ViewGenerateOptions;
      }): ViewDefinition<TName, TItem>;
      <TName extends string, TCollection extends AnyCollection>(input: {
        name: TName;
        typeName?: string;
        from: TCollection;
        where?: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        generate?: ViewGenerateOptions;
      }): ViewDefinition<
        TName,
        RemappedCollectionDocument<TCollection, TContent>
      >;
      <
        TName extends string,
        TCollections extends readonly [AnyCollection, ...AnyCollection[]],
        TItem extends Record<string, unknown>,
      >(input: {
        name: TName;
        typeName?: string;
        from: TCollections;
        where?: (
          document: MultiCollectionDocument<TCollections, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        select: (
          document: MultiSelectInput<TCollections, TContent>,
          context: ViewContext<TContent>,
        ) => TItem;
        generate?: ViewGenerateOptions;
      }): ViewDefinition<TName, TItem>;
    },
    defineIndex: ((input: Record<string, unknown>) =>
      defineIndex({ ...input, content } as never)) as unknown as {
      <
        TName extends string,
        TCollection extends AnyCollection,
        TItem extends Record<string, unknown>,
      >(input: {
        name: TName;
        typeName?: string;
        from: TCollection;
        key:
          | StringFieldKeys<RemappedCollectionDocument<TCollection, TContent>>
          | ((
              document: RemappedCollectionDocument<TCollection, TContent>,
            ) => string);
        where?: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        select: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => TItem;
        generate?: IndexGenerateOptions;
      }): IndexDefinition<TName, TItem>;
      <TName extends string, TCollection extends AnyCollection>(input: {
        name: TName;
        typeName?: string;
        from: TCollection;
        key:
          | StringFieldKeys<RemappedCollectionDocument<TCollection, TContent>>
          | ((
              document: RemappedCollectionDocument<TCollection, TContent>,
            ) => string);
        where?: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        generate?: IndexGenerateOptions;
      }): IndexDefinition<
        TName,
        RemappedCollectionDocument<TCollection, TContent>
      >;
    },
    defineGroup: ((input: Record<string, unknown>) =>
      defineGroup({ ...input, content } as never)) as unknown as {
      <
        TName extends string,
        TCollection extends AnyCollection,
        TItem extends Record<string, unknown>,
      >(input: {
        name: TName;
        typeName?: string;
        from: TCollection;
        by:
          | StringFieldKeys<RemappedCollectionDocument<TCollection, TContent>>
          | ((
              document: RemappedCollectionDocument<TCollection, TContent>,
            ) => string);
        where?: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        select: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => TItem;
        generate?: GroupGenerateOptions;
      }): GroupDefinition<TName, TItem>;
      <TName extends string, TCollection extends AnyCollection>(input: {
        name: TName;
        typeName?: string;
        from: TCollection;
        by:
          | StringFieldKeys<RemappedCollectionDocument<TCollection, TContent>>
          | ((
              document: RemappedCollectionDocument<TCollection, TContent>,
            ) => string);
        where?: (
          document: RemappedCollectionDocument<TCollection, TContent>,
          context: ViewContext<TContent>,
        ) => boolean;
        generate?: GroupGenerateOptions;
      }): GroupDefinition<
        TName,
        RemappedCollectionDocument<TCollection, TContent>
      >;
    },
  };
}

function assertLocalizationCatalog(localization: Localization): void {
  if (!localization.locales.includes(localization.defaultLocale)) {
    throw new Error(
      `defaultLocale "${localization.defaultLocale}" must be listed in locales.`,
    );
  }
}

function assertSingletonPaths(
  config: Pick<AnhurConfig, "localization">,
  singleton: AnySingleton,
): void {
  const localized = isLocalized(config, singleton);
  if (localized) {
    if (!singleton.directory) {
      throw new Error(
        `Singleton "${singleton.name}" requires directory when localization is enabled.`,
      );
    }
    return;
  }
  if (!singleton.filePath) {
    throw new Error(
      `Singleton "${singleton.name}" requires filePath when localization is off (or set project localization + directory).`,
    );
  }
}

function assertViews(
  content: readonly AnyContent[],
  views: readonly AnyDerived[] | undefined,
): void {
  if (!views?.length) return;

  const contentNames = new Set(content.map((source) => source.name));
  const collectionNames = new Set(
    content.filter(isCollection).map((source) => source.name),
  );
  const derivedNames = new Set<string>();

  for (const entry of views) {
    const label =
      entry.type === "view"
        ? "View"
        : entry.type === "index"
          ? "Index"
          : "Group";

    if (contentNames.has(entry.name)) {
      throw new Error(
        `${label} "${entry.name}" conflicts with a content source of the same name.`,
      );
    }
    if (derivedNames.has(entry.name)) {
      throw new Error(`Duplicate derived name "${entry.name}".`);
    }
    derivedNames.add(entry.name);

    if (entry.type === "view") {
      if (entry.from.length === 0) {
        throw new Error(
          `View "${entry.name}" requires at least one collection.`,
        );
      }
      if (entry.from.length > 1 && entry.select == null) {
        throw new Error(
          `View "${entry.name}" merges multiple collections and requires select().`,
        );
      }
      for (const source of entry.from) {
        if (!collectionNames.has(source.name)) {
          throw new Error(
            `View "${entry.name}" references collection "${source.name}" which is not in content.`,
          );
        }
      }
      continue;
    }

    if (!collectionNames.has(entry.from.name)) {
      throw new Error(
        `${label} "${entry.name}" references collection "${entry.from.name}" which is not in content.`,
      );
    }
  }
}

/**
 * Preserve the concrete `content` tuple and locale literals so generated
 * `.d.ts` can use `GetTypeByName<typeof configuration, "posts">` with a
 * typed `_meta.locale`.
 *
 * Package integration factories receive the exact content tuple through the
 * contextual {@link IntegrationConfigEntry} type, including when `content` is
 * an inline array.
 */
export function defineConfig<
  const TContent extends readonly AnyContent[],
  const TLocales extends readonly string[],
  const TViews extends readonly AnyDerived[] = [],
>(
  config: Omit<
    AnhurConfig,
    "content" | "integrations" | "views" | "localization"
  > & {
    content: TContent;
    views?: TViews;
    localization: FolderLocalization<TLocales>;
    integrations?: readonly import("./integrations").IntegrationInput<
      NoInfer<TContent>
    >[];
  },
): Omit<AnhurConfig, "content" | "integrations" | "views" | "localization"> & {
  content: TContent;
  views?: TViews;
  localization: FolderLocalization<TLocales>;
  integrations?: readonly import("./integrations").IntegrationInput<TContent>[];
};

export function defineConfig<
  const TContent extends readonly AnyContent[],
  const TViews extends readonly AnyDerived[] = [],
>(
  config: Omit<
    AnhurConfig,
    "content" | "integrations" | "views" | "localization"
  > & {
    content: TContent;
    views?: TViews;
    localization?: undefined;
    integrations?: readonly import("./integrations").IntegrationInput<
      NoInfer<TContent>
    >[];
  },
): Omit<AnhurConfig, "content" | "integrations" | "views" | "localization"> & {
  content: TContent;
  views?: TViews;
  integrations?: readonly import("./integrations").IntegrationInput<TContent>[];
};

export function defineConfig(
  config: Omit<AnhurConfig, "content" | "integrations" | "views"> & {
    content: readonly AnyContent[];
    views?: readonly AnyDerived[];
    integrations?: readonly import("./integrations").IntegrationInput<
      readonly AnyContent[]
    >[];
  },
): AnhurConfig {
  if (!config.content?.length) {
    throw new Error("defineConfig requires at least one content source.");
  }

  if (config.localization) {
    assertLocalizationCatalog(config.localization);
  }

  for (const source of config.content) {
    if (isSingleton(source)) {
      assertSingletonPaths(config, source);
    }
  }

  assertViews(config.content, config.views);

  return config as AnhurConfig;
}

type EmbeddedDocumentMarker =
  import("./schema/reference").EmbeddedDocument<string>;

/**
 * True when `T` contains an `EmbeddedDocument<…>` somewhere.
 * Depth-capped so recursive shapes like `TocEntry` do not loop forever.
 */
type ContainsEmbeddedRef<
  T,
  TDepth extends readonly unknown[] = [],
> = TDepth["length"] extends 8
  ? false
  : T extends EmbeddedDocumentMarker
    ? true
    : T extends readonly (infer TItem)[]
      ? ContainsEmbeddedRef<TItem, [...TDepth, unknown]>
      : T extends object
        ? true extends {
            [K in keyof T]: ContainsEmbeddedRef<T[K], [...TDepth, unknown]>;
          }[keyof T]
          ? true
          : false
        : false;

/**
 * Remap `EmbeddedDocument<"authors">` markers from `s.reference(..., { embed: true })`
 * to the real target document type from the same config.
 *
 * Types with no embedded refs (e.g. `TocEntry[]`) are left unchanged so named
 * aliases survive `GetTypeByName` instead of becoming anonymous `items: …[]`.
 *
 * When `TConfig` includes `localization`, embedded docs get a typed
 * `_meta.locale` (or no locale when the target sets `localized: false`).
 */
export type RemapEmbeddedRefs<
  T,
  TContent extends readonly AnyContent[],
  TConfig extends AnhurConfig = AnhurConfig & { content: TContent },
> = T extends import("./schema/reference").EmbeddedDocument<infer TName>
  ? TName extends string
    ? RemapEmbeddedRefs<
        DocumentForConfig<TConfig, Extract<TContent[number], { name: TName }>>,
        TContent,
        TConfig
      >
    : never
  : ContainsEmbeddedRef<T> extends true
    ? T extends readonly (infer TItem)[]
      ? RemapEmbeddedRefs<TItem, TContent, TConfig>[]
      : T extends object
        ? { [K in keyof T]: RemapEmbeddedRefs<T[K], TContent, TConfig> }
        : T
    : T;

/**
 * Locale union from `config.localization.locales` (e.g. `"en" | "cs"`).
 * `never` when the project has no localization block.
 */
export type ConfigLocale<TConfig extends AnhurConfig> = TConfig extends {
  localization: { locales: readonly (infer L)[] };
}
  ? Extract<L, string>
  : never;

type SourceIsLocalized<
  TConfig extends AnhurConfig,
  TSource extends AnyContent,
> = TConfig extends {
  localization: Localization;
}
  ? TSource extends { localized: false }
    ? false
    : true
  : false;

/** `_meta` shape for a content source under a concrete config. */
export type ContentMetaFor<
  TConfig extends AnhurConfig,
  TSource extends AnyContent,
> = Omit<ContentMeta, "locale"> &
  (SourceIsLocalized<TConfig, TSource> extends true
    ? { locale: ConfigLocale<TConfig> }
    : { locale?: undefined });

/** Document data + locale-aware `_meta` for a content source. */
export type DocumentForConfig<
  TConfig extends AnhurConfig,
  TSource extends AnyContent,
> = InferSchemaData<TSource> & {
  _meta: ContentMetaFor<TConfig, TSource>;
};

/** True when `_meta.locale` can only be undefined (monolingual source). */
type MetaLocaleIsUnset<M> = M extends { locale?: infer L }
  ? [Exclude<L, undefined>] extends [never]
    ? true
    : false
  : false;

/** Align top-level `_meta.locale` with the project locale catalog. */
type AlignMetaLocale<T, TConfig extends AnhurConfig> = T extends {
  _meta: infer M;
}
  ? MetaLocaleIsUnset<M> extends true
    ? T
    : Omit<T, "_meta"> & {
        _meta: Omit<Extract<M, object>, "locale"> &
          ([ConfigLocale<TConfig>] extends [never]
            ? { locale?: undefined }
            : { locale: ConfigLocale<TConfig> });
      }
  : T;

/**
 * Light-list shape: omit keys from the document and from nested embeds
 * (objects with `_meta`, from `s.reference(..., { embed: true })`).
 *
 * Used by generated `PostListItem` / view list item aliases so TypeScript
 * matches runtime `toListExport` (parent `body` and embedded `body` both go).
 */
export type OmitListFields<T, K extends PropertyKey> = T extends {
  _meta: ContentMeta;
}
  ? Omit<{ [P in keyof T]: OmitListFieldsValue<T[P], K> }, K>
  : T;

type OmitListFieldsValue<V, K extends PropertyKey> = V extends {
  _meta: ContentMeta;
}
  ? OmitListFields<V, K>
  : V extends readonly (infer I)[]
    ? OmitListFieldsValue<I, K>[]
    : V;

/**
 * Resolve a content source by name from a config object.
 * Used by generated `.d.ts` files.
 */
export type GetTypeByName<
  TConfig extends AnhurConfig,
  TName extends TConfig["content"][number]["name"],
> = RemapEmbeddedRefs<
  DocumentForConfig<
    TConfig,
    Extract<TConfig["content"][number], { name: TName }>
  >,
  TConfig["content"],
  TConfig
>;

/** Infer list/map/group item data from a derived definition. */
export type InferViewData<T> =
  T extends ViewDefinition<string, infer TData>
    ? TData
    : T extends IndexDefinition<string, infer TData>
      ? TData
      : T extends GroupDefinition<string, infer TData>
        ? TData
        : never;

/** Names of derived exports (`views`) on a config. */
export type DerivedName<TConfig extends AnhurConfig> =
  NonNullable<TConfig["views"]> extends readonly AnyDerived[]
    ? NonNullable<TConfig["views"]>[number]["name"]
    : never;

/**
 * Resolve a derived item type by name from a config object.
 * Used by generated `.d.ts` files (views, indexes, and groups).
 *
 * Remaps `embed: true` references the same way as {@link GetTypeByName},
 * so view items stay assignable to collection light-list item types when
 * shapes match. Top-level `_meta.locale` matches {@link ConfigLocale} when
 * the source is localized; monolingual views (`localized: false`) keep
 * `locale?: undefined`.
 */
export type GetViewByName<
  TConfig extends AnhurConfig,
  TName extends DerivedName<TConfig> = DerivedName<TConfig>,
> =
  NonNullable<TConfig["views"]> extends readonly AnyDerived[]
    ? AlignMetaLocale<
        RemapEmbeddedRefs<
          InferViewData<
            Extract<NonNullable<TConfig["views"]>[number], { name: TName }>
          >,
          TConfig["content"],
          TConfig
        >,
        TConfig
      >
    : never;
