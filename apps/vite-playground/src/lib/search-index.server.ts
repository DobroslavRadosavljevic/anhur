import { readFile } from "node:fs/promises";
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

let searcherPromise: Promise<Searcher> | undefined;

/** Load the build-time Orama snapshot once (server). */
export function getSearcher(): Promise<Searcher> {
  searcherPromise ??= (async () => {
    const raw = await readFile(indexPath, "utf8");
    const snapshot = JSON.parse(raw) as AnhurOramaIndex;
    return createSearcher(snapshot);
  })();
  return searcherPromise;
}
