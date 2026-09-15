import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSearcher,
  type AnhurOramaIndex,
  type Searcher,
} from "@anhur/orama/client";

const indexPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.anhur/generated/search/orama.json",
);

type Cache = {
  mtimeMs: number;
  searcher: Promise<Searcher>;
};

let cache: Cache | undefined;

async function loadSearcher(): Promise<Searcher> {
  const raw = await readFile(indexPath, "utf8");
  // SAFETY: Anhur complete writes this file as AnhurOramaIndex JSON.
  const snapshot = JSON.parse(raw) as AnhurOramaIndex;
  return createSearcher(snapshot);
}

/**
 * Load (and reload) the build-time Orama snapshot when the file changes.
 * Vite rebuilds rewrite this JSON; a forever cache would serve stale hits.
 */
export async function getSearcher(): Promise<Searcher> {
  const info = await stat(indexPath);
  if (!cache || cache.mtimeMs !== info.mtimeMs) {
    cache = {
      mtimeMs: info.mtimeMs,
      searcher: loadSearcher(),
    };
  }
  return cache.searcher;
}

/** Test helper — drop the in-memory searcher so the next call reloads. */
export function clearSearcherCache(): void {
  cache = undefined;
}
