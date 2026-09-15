import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CacheFingerprint } from "./cache-fingerprint";
import type { DocumentFields } from "./document-fields";

export type PersistCache = {
  /**
   * Return a cached JSON value or compute, persist, and return it.
   * `key` should be stable per document/operation (e.g. `mdx:/abs/path`).
   */
  getOrCompute: <T>(
    key: string,
    input: CacheFingerprint,
    compute: () => Promise<T>,
  ) => Promise<T>;
};

function hashKey(key: string, input: CacheFingerprint): string {
  return createHash("sha256")
    .update(key)
    .update("\0")
    .update(JSON.stringify(input) ?? "null")
    .digest("hex");
}

function safeFileName(key: string, digest: string): string {
  const readable = key
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .slice(0, 40);
  return `${readable}_${digest.slice(0, 16)}.json`;
}

/**
 * Disk-backed cache under `.anhur/cache` (or `cacheDir`).
 * Used by heavy field helpers (MDX / Markdown compile).
 */
export async function createPersistCache(
  cacheDir: string,
): Promise<PersistCache> {
  await mkdir(cacheDir, { recursive: true });
  const memory = new Map<string, DocumentFields>();

  return {
    async getOrCompute(key, input, compute) {
      const digest = hashKey(key, input);
      const memKey = `${key}:${digest}`;
      const cached = memory.get(memKey);
      if (cached !== undefined) {
        // SAFETY: entries are only written from compute() or JSON.parse of that same T.
        return cached as never;
      }

      const filePath = path.join(cacheDir, safeFileName(key, digest));
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed: DocumentFields = JSON.parse(raw);
        memory.set(memKey, parsed);
        // SAFETY: file was written by JSON.stringify of T from getOrCompute.
        return parsed as never;
      } catch {
        // miss or corrupt — recompute
      }

      const output = await compute();
      // SAFETY: preserves the existing runtime contract for this assignment.
      memory.set(memKey, output as DocumentFields);
      try {
        await writeFile(filePath, JSON.stringify(output), "utf8");
      } catch {
        // cache write is best-effort
      }
      return output;
    },
  };
}
