import type { AnyContent, ContentPlugin, GetTypeByName } from "@anhur/core";
import type { RawData } from "@orama/orama";
import type { StemmerLanguage } from "./stemmers";
import type { TokenizerSpec } from "./tokenizer";

/** Searchable field types. */
export type OramaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string[]"
  | "number[]"
  | "boolean[]"
  | "enum[]";

/** Field name → type. */
export type OramaSchema = { readonly [field: string]: OramaFieldType };

/** Value an `index()` result must give for a field type. */
export type OramaFieldValue<T extends OramaFieldType> = T extends
  | "string"
  | "enum"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "string[]" | "enum[]"
        ? readonly string[]
        : T extends "number[]"
          ? readonly number[]
          : T extends "boolean[]"
            ? readonly boolean[]
            : never;

/**
 * What `index()` returns: every `schema` field. `undefined` leaves the field
 * out of the index for that document (an optional value).
 */
export type IndexValues<TSchema extends OramaSchema> = {
  readonly [K in keyof TSchema]: OramaFieldValue<TSchema[K]> | undefined;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * What `store()` may return: JSON, where object values may also be
 * `undefined` (the key is left out, as `JSON.stringify` does). `Date`,
 * `BigInt`, `Map`, class instances and functions are rejected.
 */
export type StoreValue = JsonPrimitive | readonly StoreValue[] | StoreObject;
export type StoreObject = { readonly [key: string]: StoreValue | undefined };

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A `store()` result after the JSON round trip: `undefined` values become optional keys. */
export type StoredJson<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly StoredJson<TItem>[]
    : Simplify<
        {
          readonly [
            K in keyof T as undefined extends T[K] ? never : K
          ]: StoredJson<T[K]>;
        } & {
          readonly [
            K in keyof T as undefined extends T[K] ? K : never
          ]?: StoredJson<Exclude<T[K], undefined>>;
        }
      >;

/** Collection names of a content tuple. */
export type CollectionName<TContent extends readonly AnyContent[]> = Extract<
  TContent[number],
  { type: "collection" }
>["name"];

/** Final document type of a collection (embeds remapped, transform fields included). */
export type SearchDocument<
  TContent extends readonly AnyContent[],
  TName extends CollectionName<TContent>,
> = GetTypeByName<{ readonly content: TContent }, TName>;

/** Search settings of one collection. */
export type CollectionSearch<
  TDocument,
  TSchema extends OramaSchema = OramaSchema,
  TStore extends StoreObject = StoreObject,
> = {
  /** Fields to index and their types. */
  readonly schema: TSchema;
  /** Values for exactly the fields in `schema` (`undefined` = not indexed). */
  readonly index: (document: TDocument) => IndexValues<TSchema>;
  /** Payload returned with each hit (not searchable). Default `{}`. */
  readonly store?: (document: TDocument) => TStore;
};

/** What `orama()` infers `collections` against: known collection names and their document types. */
export type SearchCollections<TContent extends readonly AnyContent[]> = {
  readonly [K in CollectionName<TContent>]?: CollectionSearch<
    SearchDocument<TContent, K>
  >;
};

type SchemaOf<TEntry> = TEntry extends { readonly schema: infer TSchema }
  ? TSchema extends OramaSchema
    ? TSchema
    : never
  : never;

type IndexResultOf<TEntry> = TEntry extends {
  readonly index: (document: never) => infer TResult;
}
  ? TResult
  : never;

/** `index()` result checked against the schema: every field, no extra keys. */
type ExactIndexValues<
  TSchema extends OramaSchema,
  TResult,
> = IndexValues<TSchema> & {
  readonly [K in Exclude<keyof TResult, keyof TSchema>]: never;
};

/** Field names must not contain "." (Orama reads them as nested paths). */
type CheckedSchema<TSchema extends OramaSchema> = {
  readonly [K in keyof TSchema]: K extends `${string}.${string}`
    ? never
    : TSchema[K];
};

/** `collections` checked: known collection names, exact `index()` results. */
export type CheckedCollections<
  TContent extends readonly AnyContent[],
  TCollections,
> = {
  readonly [K in keyof TCollections]: K extends CollectionName<TContent>
    ? {
        readonly schema: CheckedSchema<SchemaOf<TCollections[K]>>;
        readonly index: (
          document: SearchDocument<TContent, K>,
        ) => ExactIndexValues<
          SchemaOf<TCollections[K]>,
          IndexResultOf<TCollections[K]>
        >;
        readonly store?: (document: SearchDocument<TContent, K>) => StoreObject;
      }
    : never;
};

/** Per-collection hit store types of a `collections` object. */
export type StoresOf<TCollections> = {
  readonly [K in keyof TCollections & string]: TCollections[K] extends {
    readonly store?: (document: never) => infer TStore;
  }
    ? StoredJson<TStore>
    : StoredJson<{}>;
};

/** Names of the string fields (`string`, `string[]`) of a `collections` object. */
export type StringFieldsOf<TCollections> = {
  [K in keyof TCollections]: {
    [F in keyof SchemaOf<TCollections[K]>]: SchemaOf<
      TCollections[K]
    >[F] extends "string" | "string[]"
      ? F
      : never;
  }[keyof SchemaOf<TCollections[K]>];
}[keyof TCollections] &
  string;

export type OramaOptions<
  TContent extends readonly AnyContent[] = readonly AnyContent[],
  TCollections = SearchCollections<TContent>,
> = {
  /** Per collection search settings, keyed by collection name. */
  readonly collections: TCollections &
    CheckedCollections<TContent, TCollections>;
  /**
   * Stemming language per locale (`{ en: "english", de: "german" }`). Keys
   * are locales from `localization`, or `"default"` without localization.
   * Locales not listed are tokenized without stemming.
   */
  readonly languages?: { readonly [locale: string]: StemmerLanguage };
  /** Generated module folder / file stem. Default `search`. */
  readonly path?: string;
};

declare const oramaTypes: unique symbol;

/** Type-level facts about an `orama()` entry, read by the generated `AnhurSearchStores`. */
export type OramaPluginTypes<TStores> = { readonly stores: TStores };

/**
 * Plugin name of an `orama()` entry: `"orama"` at runtime, branded with the
 * hit store types (a phantom key) so they survive in `typeof config`.
 */
export type OramaPluginName<TStores> = "orama" & {
  readonly [oramaTypes]?: OramaPluginTypes<TStores>;
};

/** What `orama()` returns: a plugin entry that also carries its hit store types. */
export type OramaPlugin<
  TContent extends readonly AnyContent[],
  TStores,
> = ContentPlugin<TContent, OramaPluginName<TStores>>;

type PluginStores<TPlugin> = TPlugin extends (...args: never) => infer TResult
  ? TResult extends { readonly name: infer TName }
    ? TName extends { readonly [oramaTypes]?: infer TTypes }
      ? unknown extends TTypes
        ? never
        : TTypes extends OramaPluginTypes<infer TStores>
          ? TStores
          : never
      : never
    : never
  : never;

type ConfigPlugins<TConfig> = TConfig extends {
  readonly plugins?: infer TPlugins;
}
  ? TPlugins extends readonly (infer TPlugin)[]
    ? TPlugin
    : never
  : never;

type DefaultStoresFor<TName extends string> = {
  readonly [K in TName]: JsonObject;
};

/**
 * Hit store types of the `orama()` entry in a config (what the generated
 * `AnhurSearchStores` is). Falls back to `JsonObject` per collection when the
 * config type does not keep its `plugins` entries.
 */
export type SearchStoresOf<TConfig, TName extends string> = [
  PluginStores<ConfigPlugins<TConfig>>,
] extends [never]
  ? DefaultStoresFor<TName>
  : PluginStores<ConfigPlugins<TConfig>>;

type DefaultStores = { readonly [collection: string]: JsonObject };

declare const storesKey: unique symbol;
declare const fieldsKey: unique symbol;

/** One locale's search index, as emitted at build time. */
export type AnhurSearchIndex<
  TStores = DefaultStores,
  TField extends string = string,
> = {
  readonly version: 4;
  readonly locale: string;
  readonly tokenizer: TokenizerSpec;
  readonly schema: OramaSchema;
  /** String fields searched by default. */
  readonly searchProperties: readonly TField[];
  readonly collections: readonly string[];
  readonly data: RawData;
  /** Phantom: store payload types per collection. */
  readonly [storesKey]?: TStores;
  /** Phantom: searchable field names. */
  readonly [fieldsKey]?: TField;
};

export type SearchQuery<
  TStores = DefaultStores,
  TField extends string = string,
> = {
  /** Text to find. Trimmed; an empty term finds nothing. */
  readonly term: string;
  /** Only these collections. */
  readonly collection?:
    | (keyof TStores & string)
    | readonly (keyof TStores & string)[];
  readonly limit?: number;
  readonly offset?: number;
  /** Typo tolerance (edit distance). */
  readonly tolerance?: number;
  /** 0–1: share of partial matches kept. `0` = every word must match. Default 1. */
  readonly threshold?: number;
  /** Positive field weights, e.g. `{ title: 2 }`. `0` ignores the boost. */
  readonly boost?: { readonly [F in TField]?: number };
  /** String fields to match. Default: every string field. */
  readonly properties?: readonly TField[];
};

/** A search hit; `collection` tells which `store` type it has. */
export type SearchHit<TStores = DefaultStores> = {
  readonly [K in keyof TStores & string]: {
    readonly id: string;
    readonly score: number;
    readonly collection: K;
    readonly documentId: string;
    readonly store: TStores[K];
  };
}[keyof TStores & string];

export type SearchResult<TStores = DefaultStores> = {
  readonly count: number;
  readonly elapsed: { readonly raw: number; readonly formatted: string };
  readonly hits: readonly SearchHit<TStores>[];
};
