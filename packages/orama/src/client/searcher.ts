import { create, load, search } from "@orama/orama";
import { tokenizerFor } from "../tokenizer-for";
import type {
  AnhurSearchIndex,
  SearchHit,
  SearchQuery,
  SearchResult,
} from "../types";

/** Searches one locale's index. */
export type Searcher<TStores, TField extends string = string> = {
  readonly locale: string;
  readonly collections: readonly string[];
  readonly search: (
    query: SearchQuery<TStores, TField>,
  ) => Promise<SearchResult<TStores>>;
};

type Row = {
  readonly id: string;
  readonly collection: string;
  readonly documentId: string;
  readonly store: unknown;
};

function isRow(value: unknown): value is Row {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "collection" in value &&
    typeof value.collection === "string" &&
    "documentId" in value &&
    typeof value.documentId === "string"
  );
}

function isSearchIndex(value: unknown): value is AnhurSearchIndex<never> {
  return (
    value !== null &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 4 &&
    "data" in value &&
    "schema" in value &&
    "tokenizer" in value
  );
}

/** Checked `boost`: known string fields, positive weights; `0` drops the boost. */
function boostFor(
  boost: { readonly [field: string]: number | undefined } | undefined,
  fields: ReadonlySet<string>,
) {
  const weights = Object.entries(boost ?? {}).flatMap(([field, weight]) => {
    if (!fields.has(field)) {
      throw new Error(
        `@anhur/orama: boost has "${field}", which is not a searchable string field.`,
      );
    }
    if (weight === undefined || weight === 0) return [];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `@anhur/orama: boost.${field} must be a positive number, not ${String(weight)}.`,
      );
    }
    return [[field, weight] as const];
  });
  return Object.fromEntries(weights);
}

function propertiesFor(
  properties: readonly string[] | undefined,
  fields: ReadonlySet<string>,
): string[] {
  if (properties === undefined) return [...fields];
  for (const property of properties) {
    if (!fields.has(property)) {
      throw new Error(
        `@anhur/orama: "${property}" is not a searchable string field (use one of ${[...fields].map((field) => `"${field}"`).join(", ")}).`,
      );
    }
  }
  return [...properties];
}

/**
 * Load an index from `loadSearchIndex(locale)` and search it. Works in the
 * browser and on the server; the tokenizer (and stemmer, loaded on demand)
 * matches the one used at build.
 */
export async function createSearcher<TStores, TField extends string = string>(
  index: AnhurSearchIndex<TStores, TField>,
): Promise<Searcher<TStores, TField>> {
  if (!isSearchIndex(index)) {
    throw new Error(
      "@anhur/orama: not a search index (expected version 4 from loadSearchIndex(); rebuild after upgrading @anhur/orama).",
    );
  }
  const db = create({
    schema: index.schema,
    sort: { enabled: false },
    components: { tokenizer: await tokenizerFor(index.tokenizer) },
  });
  load(db, index.data);
  const fields = new Set<string>(index.searchProperties);

  const run = async (
    query: SearchQuery<TStores, TField>,
  ): Promise<SearchResult<TStores>> => {
    const properties = propertiesFor(query.properties, fields);
    const boost = boostFor(query.boost, fields);
    const term = query.term.trim();
    if (term.length === 0) {
      return { count: 0, elapsed: { raw: 0, formatted: "0μs" }, hits: [] };
    }
    const collections =
      query.collection === undefined
        ? undefined
        : Array.isArray(query.collection)
          ? [...query.collection]
          : [query.collection];
    const result = await search(db, {
      term,
      limit: query.limit ?? 10,
      offset: query.offset ?? 0,
      tolerance: query.tolerance,
      threshold: query.threshold,
      boost,
      properties,
      where: collections ? { collection: { in: collections } } : undefined,
    });
    const hits = result.hits.flatMap((hit) => {
      const document: unknown = hit.document;
      if (!isRow(document)) return [];
      // SAFETY: rows of collection K were built with that collection's store() at build time.
      const typed = {
        id: hit.id,
        score: hit.score,
        collection: document.collection,
        documentId: document.documentId,
        store: document.store,
      } as SearchHit<TStores>;
      return [typed];
    });
    return { count: result.count, elapsed: result.elapsed, hits };
  };

  return { locale: index.locale, collections: index.collections, search: run };
}
