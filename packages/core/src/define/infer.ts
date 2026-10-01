import type { ContentMeta, DocumentWithMeta } from "../document";
import type {
  AnyContent,
  AnyDerived,
  CollectionDefinition,
  ContentSchema,
  GroupDefinition,
  IndexDefinition,
  Localization,
  SingletonDefinition,
  ViewDefinition,
} from "./types";

/**
 * The parts of a config the type helpers read. `typeof config` from
 * `defineConfig` satisfies it, and so does a plain `{ content }`.
 */
export type TypedConfig = {
  readonly content: readonly AnyContent[];
  readonly localization?: Localization;
  readonly views?: readonly AnyDerived[];
};

declare const embeddedBrand: unique symbol;

/**
 * Type of `s.reference(name, { embed: true })` before the relations pass:
 * a string id, branded with the target source name. Generated types remap
 * it to the full target document.
 */
export type EmbeddedDocument<TSource extends string = string> = string & {
  readonly [embeddedBrand]: TSource;
};

/** Document data (without `_meta`) of a content definition. */
export type InferSchemaData<T> =
  T extends CollectionDefinition<string, ContentSchema, infer TData>
    ? TData
    : T extends SingletonDefinition<string, ContentSchema, infer TData>
      ? TData
      : never;

/** Document data with `_meta` (embeds not remapped). */
export type InferDocument<T> = DocumentWithMeta<InferSchemaData<T>>;

declare const unboundEmbedBrand: unique symbol;

/**
 * An `embed: true` reference inside plain `defineView` / `defineIndex` /
 * `defineGroup` callbacks. At runtime it is the target document, but its
 * type needs the content tuple, so it is opaque here: bind the helpers with
 * `createDerivedHelpers(content)` to read its fields. Generated types remap
 * it to the target document.
 */
export type UnboundEmbed<TSource extends string = string> = {
  readonly [unboundEmbedBrand]: TSource;
};

/** True when `T` contains an `EmbeddedDocument` or `UnboundEmbed` (depth-capped). */
type ContainsEmbeddedRef<
  T,
  TDepth extends readonly unknown[] = [],
> = TDepth["length"] extends 8
  ? false
  : T extends EmbeddedDocument | UnboundEmbed
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

/** Values that are never walked into (their methods are not data). */
type OpaqueValue =
  | Date
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | ((...args: never[]) => void);

/**
 * Replace `EmbeddedDocument<"authors">` (and `UnboundEmbed<"authors">`)
 * with the final `authors` document type from the same content tuple.
 * Values without embeds keep their alias.
 */
export type RemapEmbeddedRefs<
  T,
  TContent extends readonly AnyContent[],
  TConfig extends TypedConfig = { readonly content: TContent },
> =
  T extends EmbeddedDocument<infer TName>
    ? RemapEmbeddedRefs<
        DocumentForConfig<TConfig, Extract<TContent[number], { name: TName }>>,
        TContent,
        TConfig
      >
    : T extends UnboundEmbed<infer TName>
      ? RemapEmbeddedRefs<
          DocumentForConfig<
            TConfig,
            Extract<TContent[number], { name: TName }>
          >,
          TContent,
          TConfig
        >
      : ContainsEmbeddedRef<T> extends true
        ? T extends readonly (infer TItem)[]
          ? RemapEmbeddedRefs<TItem, TContent, TConfig>[]
          : T extends object
            ? { [K in keyof T]: RemapEmbeddedRefs<T[K], TContent, TConfig> }
            : T
        : T;

/**
 * Turn embedded references into {@link UnboundEmbed} (plain derived
 * helpers: the runtime value is a document, not the string id).
 */
export type HideEmbeddedRefs<
  T,
  TDepth extends readonly unknown[] = [],
> = TDepth["length"] extends 8
  ? T
  : T extends EmbeddedDocument<infer TName extends string>
    ? UnboundEmbed<TName>
    : ContainsEmbeddedRef<T> extends true
      ? T extends readonly (infer TItem)[]
        ? HideEmbeddedRefs<TItem, [...TDepth, unknown]>[]
        : T extends OpaqueValue
          ? T
          : T extends object
            ? { [K in keyof T]: HideEmbeddedRefs<T[K], [...TDepth, unknown]> }
            : T
      : T;

/** Target names of embedded references in a schema value (`never` when none). */
type EmbedTargets<TSchema> =
  TSchema extends EmbeddedDocument<infer TName extends string> ? TName : never;

/** Every variant of the schema value is an embedded reference. */
type OnlyEmbeds<TSchema> = [Exclude<TSchema, undefined | null>] extends [never]
  ? false
  : [Exclude<TSchema, undefined | null>] extends [EmbeddedDocument]
    ? true
    : false;

/** Value at key `K` in any variant of the schema data. */
type SchemaProp<TSchema, K> = TSchema extends unknown
  ? K extends keyof TSchema
    ? TSchema[K]
    : never
  : never;

type SchemaItem<TSchema> = TSchema extends readonly (infer TItem)[]
  ? TItem
  : never;

/**
 * Align a transform result with the schema's embedded references, the way
 * the relations pass does at runtime: a string at a location where the
 * schema has `s.reference(…, { embed: true })` is embedded (the transform
 * may rebuild it, `String(doc.author)` included); a branded id moved to a
 * location without a reference stays a plain string.
 */
export type AlignEmbeddedRefs<
  TOut,
  TSchema,
  TDepth extends readonly unknown[] = [],
> = TDepth["length"] extends 8
  ? TOut
  : TOut extends EmbeddedDocument
    ? [EmbedTargets<TSchema>] extends [never]
      ? string
      : TOut
    : TOut extends string
      ? OnlyEmbeds<TSchema> extends true
        ? EmbeddedDocument<EmbedTargets<TSchema>>
        : TOut
      : TOut extends OpaqueValue
        ? TOut
        : ContainsEmbeddedRef<TOut> | ContainsEmbeddedRef<TSchema> extends false
          ? TOut
          : TOut extends readonly (infer TItem)[]
            ? AlignEmbeddedRefs<
                TItem,
                SchemaItem<TSchema>,
                [...TDepth, unknown]
              >[]
            : TOut extends object
              ? {
                  [K in keyof TOut]: AlignEmbeddedRefs<
                    TOut[K],
                    SchemaProp<TSchema, K>,
                    [...TDepth, unknown]
                  >;
                }
              : TOut;

/** Locale union of a config (`"en" | "de"`), `never` without localization. */
export type ConfigLocale<TConfig extends TypedConfig> = TConfig extends {
  localization: { locales: readonly (infer L)[] };
}
  ? Extract<L, string>
  : never;

type SourceIsLocalized<
  TConfig extends TypedConfig,
  TSource extends AnyContent,
> = TConfig extends { localization: Localization }
  ? TSource extends { localized: false }
    ? false
    : true
  : false;

/** `_meta` of a source under a concrete config (typed `locale`). */
export type ContentMetaFor<
  TConfig extends TypedConfig,
  TSource extends AnyContent,
> = Omit<ContentMeta, "locale"> &
  (SourceIsLocalized<TConfig, TSource> extends true
    ? { locale: ConfigLocale<TConfig> }
    : { locale?: undefined });

/** Document data + locale-aware `_meta`. */
export type DocumentForConfig<
  TConfig extends TypedConfig,
  TSource extends AnyContent,
> = InferSchemaData<TSource> & { _meta: ContentMetaFor<TConfig, TSource> };

/** Final document type of a content source by name (used by generated `.d.ts`). */
export type GetTypeByName<
  TConfig extends TypedConfig,
  TName extends TConfig["content"][number]["name"],
> = RemapEmbeddedRefs<
  DocumentForConfig<
    TConfig,
    Extract<TConfig["content"][number], { name: TName }>
  >,
  TConfig["content"],
  TConfig
>;

/** Item data of a view / index / group definition. */
export type InferViewData<T> =
  T extends ViewDefinition<string, infer TData>
    ? TData
    : T extends IndexDefinition<string, infer TData>
      ? TData
      : T extends GroupDefinition<string, infer TData>
        ? TData
        : never;

/** Names of derived entries on a config. */
export type DerivedName<TConfig extends TypedConfig> =
  NonNullable<TConfig["views"]> extends readonly AnyDerived[]
    ? NonNullable<TConfig["views"]>[number]["name"]
    : never;

type MetaLocaleIsUnset<M> = M extends { locale?: infer L }
  ? [Exclude<L, undefined>] extends [never]
    ? true
    : false
  : false;

type AlignMetaLocale<T, TConfig extends TypedConfig> = T extends {
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

/** Item type of a derived entry by name (used by generated `.d.ts`). */
export type GetViewByName<
  TConfig extends TypedConfig,
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

/**
 * Light-list shape: omit keys from the document and from nested embedded
 * documents (objects with `_meta`), matching the runtime list export.
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
