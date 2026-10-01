import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { readHitStore } from "~/lib/search-store";

/** Longest accepted query; longer input is rejected before tokenizing. */
const MAX_TERM_LENGTH = 200;

const searchInput = z.object({
  term: z.string().trim().max(MAX_TERM_LENGTH),
  locale: z.enum(["en", "de"]),
  collection: z.enum(["posts", "pages", "products", "changelog"]).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

/**
 * Server-side search over the same generated index the browser loads.
 * Index loading stays inside the handler so the client bundle never
 * includes it twice.
 */
export const searchContent = createServerFn({ method: "GET" })
  .validator((data) => searchInput.parse(data))
  .handler(async ({ data }) => {
    const { getSearcher } = await import("~/lib/search-index.server");
    const searcher = await getSearcher(data.locale);
    const result = await searcher.search({
      term: data.term,
      collection: data.collection,
      limit: data.limit,
    });
    return {
      count: result.count,
      elapsed: result.elapsed.formatted,
      hits: result.hits.map((hit) => ({
        id: hit.id,
        score: hit.score,
        collection: hit.collection,
        documentId: hit.documentId,
        store: readHitStore(hit.store),
      })),
    };
  });
