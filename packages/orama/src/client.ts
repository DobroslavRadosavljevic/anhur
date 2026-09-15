import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import type {
  AnhurOramaIndex,
  JsonObject,
  JsonValue,
  OramaIndexDocument,
  OramaSchema,
  SearchHit,
  SearchQuery,
  SearchResult,
} from "./types";

export type { AnhurOramaIndex, SearchHit, SearchQuery, SearchResult };

type StringFilters = {
  [field: string]: string;
};

type OramaSearchInput = {
  term: string;
  limit: number;
  properties: string[] | "*";
  where?: StringFilters;
};

export type Searcher = {
  /** Search all indexed collections (optional filters). */
  search: <TStore = JsonObject>(
    query: SearchQuery,
  ) => Promise<SearchResult<TStore>>;
  /** Search a single collection. */
  searchCollection: <TStore = JsonObject>(
    collection: string,
    query: Omit<SearchQuery, "collection">,
  ) => Promise<SearchResult<TStore>>;
  /** Collection names present in this index. */
  collections: readonly string[];
};

function isJsonString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function isJsonObject<T>(value: T): value is T & JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonValue(text: string): JsonValue {
  // SAFETY: JSON.parse of a store string yields a JSON value tree.
  return JSON.parse(text) as JsonValue;
}

function parseStore(raw: JsonValue): JsonObject {
  if (!isJsonString(raw) || raw.length === 0) return {};
  try {
    const value = parseJsonValue(raw);
    if (isJsonObject(value)) return value;
  } catch {
    // ignore malformed store payloads
  }
  return {};
}

function isOramaIndexDocument<T>(value: T): value is T & OramaIndexDocument {
  if (!isJsonObject(value)) return false;
  return isJsonString(value.id);
}

function toHit<TStore>(hit: {
  id: string;
  score: number;
  document: OramaIndexDocument;
}): SearchHit<TStore> {
  const doc = hit.document;
  return {
    id: hit.id,
    score: hit.score,
    collection: String(doc.collection ?? ""),
    locale: String(doc.locale ?? "default"),
    documentId: String(doc.documentId ?? ""),
    // SAFETY: hit stores are JSON objects parsed from the index snapshot.
    store: parseStore(doc.store) as TStore,
  };
}

function isOramaSchema<T>(value: T): value is T & OramaSchema {
  return isJsonObject(value);
}

export function isAnhurOramaIndex<T>(value: T): value is T & AnhurOramaIndex {
  if (!isJsonObject(value)) return false;
  if (value.version !== 2) return false;
  if (!Array.isArray(value.searchProperties)) return false;
  if (!Array.isArray(value.collections)) return false;
  if (!Array.isArray(value.documents)) return false;
  if (!isOramaSchema(value.schema)) return false;
  return true;
}

/**
 * Rebuild a searcher from a portable Anhur Orama snapshot
 * (the JSON written by `orama()` at build time).
 */
export async function createSearcher<T>(persisted: T): Promise<Searcher> {
  if (!isAnhurOramaIndex(persisted)) {
    throw new Error(
      "@anhur/orama: invalid search index (expected AnhurOramaIndex v2).",
    );
  }
  const index = persisted;
  const db = create({
    // SAFETY: Orama create() accepts our portable field-type schema.
    schema: index.schema,
  });
  if (index.documents.length > 0) {
    insertMultiple(db, index.documents);
  }

  const defaultProperties =
    index.searchProperties.length > 0 ? index.searchProperties : undefined;

  async function runSearch<TStore>(
    query: SearchQuery,
  ): Promise<SearchResult<TStore>> {
    const where: StringFilters = {};
    if (query.collection) where.collection = query.collection;
    if (query.locale) where.locale = query.locale;

    const searchInput: OramaSearchInput = {
      term: query.term,
      limit: query.limit ?? 10,
      properties: query.properties ?? defaultProperties ?? "*",
    };
    if (Object.keys(where).length > 0) {
      searchInput.where = where;
    }

    const result = await oramaSearch(db, searchInput);

    return {
      count: result.count,
      elapsed: result.elapsed,
      hits: result.hits.map((hit) => {
        if (!isOramaIndexDocument(hit.document)) {
          throw new Error("@anhur/orama: search hit is missing a document id.");
        }
        return toHit<TStore>({
          id: hit.id,
          score: hit.score,
          document: hit.document,
        });
      }),
    };
  }

  return {
    collections: index.collections,
    search: runSearch,
    searchCollection: (collection, query) =>
      runSearch({ ...query, collection }),
  };
}
