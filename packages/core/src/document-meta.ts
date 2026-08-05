import { AsyncLocalStorage } from "node:async_hooks";
import type { AnhurConfig } from "./config";

/**
 * Per-document context available to Zod helpers during `safeParseAsync`.
 */
export type DocumentMeta = {
  /** Absolute file path. */
  path: string;
  /**
   * Logical document id (path under the locale/source folder, without extension).
   * Same value as generated `_meta.id`. Required during normal collection.
   */
  id?: string;
  /** Body without frontmatter (matter loader). Absent for yaml/json. */
  content?: string;
  /** Collection or singleton name. */
  sourceName: string;
  /** Locale when the source is localized. */
  locale?: string;
  /** Full project config. */
  config: AnhurConfig;
};

const GLOBAL_KEY = "__anhur_document_meta_als__" as const;

type GlobalAls = typeof globalThis & {
  [GLOBAL_KEY]?: AsyncLocalStorage<DocumentMeta>;
};

/** Shared across jiti + host duplicates of this module. */
function getStorage(): AsyncLocalStorage<DocumentMeta> {
  const g = globalThis as GlobalAls;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new AsyncLocalStorage<DocumentMeta>();
  }
  return g[GLOBAL_KEY];
}

export function getDocumentMeta(): DocumentMeta {
  const meta = getStorage().getStore();
  if (!meta) {
    throw new Error(
      "Document meta is unavailable. Anhur schema helpers only work during content collection.",
    );
  }
  return meta;
}

export function withDocumentMeta<T>(
  meta: DocumentMeta,
  run: () => Promise<T>,
): Promise<T> {
  return getStorage().run(meta, run);
}
