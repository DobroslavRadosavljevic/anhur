import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type PersistCache = {
  /**
   * Return a cached JSON value or compute, persist, and return it.
   * `key` should be stable per document/operation (e.g. `mdx:/abs/path`).
   */
  getOrCompute: <T>(
    key: string,
    input: unknown,
    compute: () => Promise<T>,
  ) => Promise<T>;
};

function hashKey(key: string, input: unknown): string {
  return createHash("sha256")
    .update(key)
    .update("\0")
    .update(JSON.stringify(input))
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
  const memory = new Map<string, unknown>();

  return {
    async getOrCompute(key, input, compute) {
      const digest = hashKey(key, input);
      const memKey = `${key}:${digest}`;
      if (memory.has(memKey)) {
        return memory.get(memKey) as never;
      }

      const filePath = path.join(cacheDir, safeFileName(key, digest));
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        memory.set(memKey, parsed);
        return parsed as never;
      } catch {
        // miss or corrupt — recompute
      }

      const output = await compute();
      memory.set(memKey, output);
      try {
        await writeFile(filePath, JSON.stringify(output), "utf8");
      } catch {
        // cache write is best-effort
      }
      return output;
    },
  };
}
