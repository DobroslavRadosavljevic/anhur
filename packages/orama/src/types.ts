import type { AnyContent, InferDocument, RemapEmbeddedRefs } from "@anhur/core";

/** Orama field types supported by Anhur search (full-text MVP). */
export type OramaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "number[]"
  | "boolean[]"
  | "enum"
  | "enum[]";

/** Value TypeScript expects for an Orama schema field type. */
export type OramaFieldValue<T extends OramaFieldType> = T extends
  | "string"
  | "enum"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "string[]" | "enum[]"
        ? string[]
        : T extends "number[]"
          ? number[]
          : T extends "boolean[]"
            ? boolean[]
            : never;

/** Collection source names from a `content` array. */
export type CollectionName<TContent extends readonly AnyContent[]> = Extract<
  TContent[number],
  { type: "collection" }
>["name"];

/**
 * Document type for a named collection in `content`, including remapped
 * `embed: true` references (same idea as `GetTypeByName`).
 */
export type SearchDocument<
  TContent extends readonly AnyContent[],
  TName extends CollectionName<TContent>,
> = RemapEmbeddedRefs<
  InferDocument<Extract<TContent[number], { name: TName }>>,
  TContent
>;

/**
 * Per-collection search config. `TDoc` comes from the parent config content
 * tuple through the `orama()` factory's contextual return type.
 */
export type CollectionSearchConfig<
  TDoc,
  TSchema extends Record<string, OramaFieldType> = Record<
    string,
    OramaFieldType
  >,
> = {
  /**
   * Orama schema fragment for fields that should be searchable / filterable.
   * Base fields `collection`, `locale`, `documentId`, and `store` are added
   * automatically. Orama row `id` is `${collection}:${locale}:${documentId}`.
   */
  schema: TSchema;
  /** Map a built document to indexed field values (keys must match `schema`). */
  index: (doc: TDoc) => {
    [K in keyof TSchema]: OramaFieldValue<TSchema[K] & OramaFieldType>;
  };
  /**
   * Payload returned on each search hit (not matched by default).
   * Defaults to `{}`.
   */
  store?: (doc: TDoc) => Record<string, unknown>;
};

/** Map of optional per-collection search configs, keyed by collection name. */
export type OramaCollectionsConfig<TContent extends readonly AnyContent[]> = {
  [K in CollectionName<TContent>]?: CollectionSearchConfig<
    SearchDocument<TContent, K>
  >;
};

/**
 * Ensures every key in `TCollections` is a collection name from `content`.
 * Unknown keys (and singleton names) resolve to `never` and fail typechecking.
 */
export type ValidateOramaCollections<
  TContent extends readonly AnyContent[],
  TCollections,
> = {
  [K in keyof TCollections]: K extends CollectionName<TContent>
    ? CollectionSearchConfig<
        SearchDocument<TContent, K & CollectionName<TContent>>
      >
    : never;
};

/** Options for `orama()`; content is inferred from the parent config. */
export type OramaIntegrationOptions<
  TContent extends readonly AnyContent[] = readonly AnyContent[],
  TCollections = OramaCollectionsConfig<TContent>,
> = {
  /**
   * Directory under Anhur `outputDir` for the index file.
   * Default: `"search"`.
   */
  directory?: string;
  /** Index filename. Default: `"orama.json"`. */
  filename?: string;
  collections: TCollections & ValidateOramaCollections<TContent, TCollections>;
};

/**
 * Portable snapshot written by the Orama integration.
 * Browser + Node rebuild the DB with `create` + `insertMultiple`.
 */
export type AnhurOramaIndex = {
  version: 2;
  /** Full Orama schema used at rebuild time. */
  schema: Record<string, OramaFieldType>;
  /** Fields passed to Orama `search({ properties })`. */
  searchProperties: string[];
  /** Collection names included in this index. */
  collections: string[];
  /** Indexed rows (including Orama `id` and JSON `store`). */
  documents: Record<string, unknown>[];
};

export type SearchQuery = {
  term: string;
  /** Limit hits to one collection name. */
  collection?: string;
  /** Limit hits to one locale (`"default"` for monolingual sources). */
  locale?: string;
  limit?: number;
  /**
   * Orama properties to match. Default: indexed content fields only
   * (not `store` / `documentId` / `collection` / `locale`).
   */
  properties?: string[] | "*";
};

export type SearchHit<TStore = Record<string, unknown>> = {
  id: string;
  score: number;
  collection: string;
  locale: string;
  documentId: string;
  store: TStore;
};

export type SearchResult<TStore = Record<string, unknown>> = {
  count: number;
  elapsed: { raw: number; formatted: string };
  hits: SearchHit<TStore>[];
};
