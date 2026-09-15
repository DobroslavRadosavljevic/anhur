import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const searchInput = z.object({
  term: z.string(),
  collection: z.string().optional(),
  locale: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const hitStore = z.object({
  title: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  summary: z.string().optional(),
  sku: z.string().optional(),
  price: z.string().optional(),
  date: z.string().optional(),
  href: z.string().optional(),
});

/**
 * Server-side search over the same Orama index the browser can load.
 * Index IO stays inside the handler so the client bundle never pulls `node:fs`.
 */
export const searchContent = createServerFn({ method: "GET" })
  .validator((data) => searchInput.parse(data))
  .handler(async ({ data }) => {
    const { getSearcher } = await import("~/lib/search-index.server");
    const searcher = await getSearcher();
    const result = data.collection
      ? await searcher.searchCollection(data.collection, {
          term: data.term,
          locale: data.locale,
          limit: data.limit,
        })
      : await searcher.search({
          term: data.term,
          locale: data.locale,
          limit: data.limit,
        });

    return {
      count: result.count,
      elapsed: result.elapsed,
      hits: result.hits.map((hit) => ({
        id: hit.id,
        score: hit.score,
        collection: hit.collection,
        locale: hit.locale,
        documentId: hit.documentId,
        store: hitStore.parse(hit.store),
      })),
    };
  });
