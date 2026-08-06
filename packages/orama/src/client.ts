import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import type {
  AnhurOramaIndex,
  SearchHit,
  SearchQuery,
  SearchResult,
} from "./types";

export type {
  AnhurOramaIndex,
  SearchHit,
  SearchQuery,
  SearchResult,
} from "./types";

export type Searcher = {
  /** Search all indexed collections (optional filters). */
  search: <TStore = Record<string, unknown>>(
    query: SearchQuery,
  ) => Promise<SearchResult<TStore>>;
  /** Search a single collection. */
  searchCollection: <TStore = Record<string, unknown>>(
    collection: string,
    query: Omit<SearchQuery, "collection">,
  ) => Promise<SearchResult<TStore>>;
  /** Collection names present in this index. */
  collections: readonly string[];
};

function parseStore(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // ignore malformed store payloads
  }
  return {};
}

function toHit<TStore>(hit: {
  id: string;
  score: number;
  document: Record<string, unknown>;
}): SearchHit<TStore> {
  const doc = hit.document;
  return {
    id: hit.id,
    score: hit.score,
    collection: String(doc.collection ?? ""),
    locale: String(doc.locale ?? "default"),
    documentId: String(doc.documentId ?? ""),
    store: parseStore(doc.store) as TStore,
  };
}

function assertIndex(value: unknown): AnhurOramaIndex {
  if (
    !value ||
    typeof value !== "object" ||
    (value as AnhurOramaIndex).version !== 2 ||
    !Array.isArray((value as AnhurOramaIndex).searchProperties) ||
    !Array.isArray((value as AnhurOramaIndex).collections) ||
    !Array.isArray((value as AnhurOramaIndex).documents) ||
    !(value as AnhurOramaIndex).schema ||
    typeof (value as AnhurOramaIndex).schema !== "object"
  ) {
    throw new Error(
      "@anhur/orama: invalid search index (expected AnhurOramaIndex v2).",
    );
  }
  return value as AnhurOramaIndex;
}

/**
 * Rebuild a searcher from a portable Anhur Orama snapshot
 * (the JSON written by `orama()` at build time).
 */
export async function createSearcher(
  persisted: AnhurOramaIndex | unknown,
): Promise<Searcher> {
  const index = assertIndex(persisted);
  const db = create({
    schema: index.schema as Record<string, "string">,
  });
  if (index.documents.length > 0) {
    insertMultiple(db, index.documents);
  }

  const defaultProperties =
    index.searchProperties.length > 0 ? index.searchProperties : undefined;

  async function runSearch<TStore>(
    query: SearchQuery,
  ): Promise<SearchResult<TStore>> {
    const where: Record<string, string> = {};
    if (query.collection) where.collection = query.collection;
    if (query.locale) where.locale = query.locale;

    const result = await oramaSearch(db, {
      term: query.term,
      limit: query.limit ?? 10,
      properties: query.properties ?? defaultProperties ?? "*",
      ...(Object.keys(where).length > 0 ? { where } : {}),
    });

    return {
      count: result.count,
      elapsed: result.elapsed,
      hits: result.hits.map((hit) =>
        toHit<TStore>({
          id: hit.id,
          score: hit.score,
          document: hit.document as Record<string, unknown>,
        }),
      ),
    };
  }

  return {
    collections: index.collections,
    search: runSearch,
    searchCollection: (collection, query) =>
      runSearch({ ...query, collection }),
  };
}
