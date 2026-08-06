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

export type FolderLocalization = {
  strategy: "folder";
  locales: readonly string[];
  defaultLocale: string;
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
  /** Async getter name. Default: `getPost` from `name`. */
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

/** Document shape passed to optional `transform` hooks after validation. */
export type TransformDocument = Record<string, unknown> & {
  _meta: ContentMeta;
};

export type AnhurConfig = {
  content: readonly AnyContent[];
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

export function isSingleton(source: AnyContent): source is AnySingleton {
  return source.type === "singleton";
}

export function isCollection(source: AnyContent): source is AnyCollection {
  return source.type === "collection";
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

/** `Posts` → `Post`, `Authors` → `Author`, `Changelog` → `Changelog`. */
export function singularizePascal(pascal: string): string {
  if (pascal.endsWith("ies") && pascal.length > 3) {
    return `${pascal.slice(0, -3)}y`;
  }
  if (pascal.endsWith("sses")) {
    return pascal.slice(0, -2);
  }
  if (
    pascal.endsWith("ses") ||
    pascal.endsWith("xes") ||
    pascal.endsWith("zes") ||
    pascal.endsWith("ches") ||
    pascal.endsWith("shes")
  ) {
    return pascal.slice(0, -2);
  }
  if (pascal.endsWith("s") && pascal.length > 1 && !pascal.endsWith("ss")) {
    return pascal.slice(0, -1);
  }
  return pascal;
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
>(
  input: DefineCollectionInput<TName, TSchema, TOut>,
): CollectionDefinition<TName, TSchema, DataFromTransformOut<TOut>> {
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
  };
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
>(
  input: DefineSingletonInput<TName, TSchema, TOut>,
): SingletonDefinition<TName, TSchema, DataFromTransformOut<TOut>> {
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

/**
 * Preserve the concrete `content` tuple so generated `.d.ts` can use
 * `GetTypeByName<typeof configuration, "posts">`.
 *
 * Package integration factories receive the exact content tuple through the
 * contextual {@link IntegrationConfigEntry} type, including when `content` is
 * an inline array.
 */
export function defineConfig<const TContent extends readonly AnyContent[]>(
  config: Omit<AnhurConfig, "content" | "integrations"> & {
    content: TContent;
    integrations?: readonly import("./integrations").IntegrationInput<
      NoInfer<TContent>
    >[];
  },
): Omit<AnhurConfig, "content" | "integrations"> & {
  content: TContent;
  integrations?: readonly import("./integrations").IntegrationInput<TContent>[];
} {
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

  return config as Omit<AnhurConfig, "content" | "integrations"> & {
    content: TContent;
    integrations?: readonly import("./integrations").IntegrationInput<TContent>[];
  };
}

/** Infer document data type (without `_meta`) from a content definition. */
export type InferSchemaData<T> =
  T extends CollectionDefinition<string, ContentSchema, infer TData>
    ? TData
    : T extends SingletonDefinition<string, ContentSchema, infer TData>
      ? TData
      : never;

export type InferDocument<T> = DocumentWithMeta<InferSchemaData<T>>;

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
 */
export type RemapEmbeddedRefs<
  T,
  TContent extends readonly AnyContent[],
> = T extends import("./schema/reference").EmbeddedDocument<infer TName>
  ? TName extends string
    ? RemapEmbeddedRefs<
        DocumentWithMeta<
          InferSchemaData<Extract<TContent[number], { name: TName }>>
        >,
        TContent
      >
    : never
  : ContainsEmbeddedRef<T> extends true
    ? T extends readonly (infer TItem)[]
      ? RemapEmbeddedRefs<TItem, TContent>[]
      : T extends object
        ? { [K in keyof T]: RemapEmbeddedRefs<T[K], TContent> }
        : T
    : T;

/**
 * Resolve a content source by name from a config object.
 * Used by generated `.d.ts` files.
 */
export type GetTypeByName<
  TConfig extends AnhurConfig,
  TName extends TConfig["content"][number]["name"],
> = RemapEmbeddedRefs<
  InferDocument<Extract<TConfig["content"][number], { name: TName }>>,
  TConfig["content"]
>;
