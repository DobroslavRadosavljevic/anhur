import { createSearcher, type Searcher } from "@anhur/orama/client";
import {
  loadSearchIndex,
  type AnhurSearchField,
  type AnhurSearchStores,
  type Locale,
} from "anhur/generated";

/** Searcher over the generated index (typed stores and fields). */
export type SiteSearcher = Searcher<AnhurSearchStores, AnhurSearchField>;

const searchers = new Map<Locale, Promise<SiteSearcher>>();

/**
 * Searcher for a locale. The index is a generated module, so it is bundled
 * into the server build (no file paths to resolve at runtime) and replaced
 * by Vite on rebuilds in dev.
 */
export function getSearcher(locale: Locale): Promise<SiteSearcher> {
  let searcher = searchers.get(locale);
  if (!searcher) {
    searcher = loadSearchIndex(locale).then(createSearcher);
    searcher.catch(() => searchers.delete(locale));
    searchers.set(locale, searcher);
  }
  return searcher;
}
