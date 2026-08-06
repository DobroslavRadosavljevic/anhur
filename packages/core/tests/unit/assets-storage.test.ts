import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineCollection,
  defineConfig,
  defineProcessor,
  syncEmittedAssetsStorage,
  type AssetStorageClient,
  schema as s,
} from "../../src/index";

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function createMemoryFiles(
  initial: Record<string, Uint8Array> = {},
): AssetStorageClient & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>(
    Object.entries(initial).map(([key, value]) => [key, value]),
  );

  return {
    store,
    async upload(key, body) {
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(body);
      store.set(key, bytes);
    },
    async exists(key) {
      return store.has(key);
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) store.delete(k);
    },
    async *listAll(opts) {
      const prefix = opts?.prefix ?? "";
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) yield { key };
      }
    },
  };
}

describe("syncEmittedAssetsStorage", () => {
  it("is a no-op when storage.enabled is false", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-off-"));
    scratchRoots.push(root);

    const files = createMemoryFiles();
    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "https://cdn.example.com/anhur/",
          storage: {
            enabled: false,
            files,
            prefix: "anhur",
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });
    const source = path.join(root, "a.png");
    await writeFile(source, "bytes");
    await ctx.emitAsset(source);

    const result = await syncEmittedAssetsStorage(ctx);
    expect(result).toBeUndefined();
    expect(files.store.size).toBe(0);
  });

  it("uploads new keys, skips existing, and prunes orphans", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-sync-"));
    scratchRoots.push(root);

    const files = createMemoryFiles({
      "anhur/orphan-deadbeef.png": new TextEncoder().encode("orphan"),
    });

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "https://cdn.example.com/anhur/",
          storage: {
            enabled: true,
            files,
            prefix: "anhur",
            prune: true,
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });
    const source = path.join(root, "cover.png");
    await writeFile(source, "cover-bytes");
    const emitted = await ctx.emitAsset(source);
    const keepKey = `anhur/${path.basename(emitted.outputPath)}`;

    const first = await syncEmittedAssetsStorage(ctx);
    expect(first?.dryRun).toBe(false);
    expect(first?.uploaded).toEqual([keepKey]);
    expect(first?.deleted).toEqual(["anhur/orphan-deadbeef.png"]);
    expect(files.store.has(keepKey)).toBe(true);
    expect(files.store.has("anhur/orphan-deadbeef.png")).toBe(false);
    expect(await readFile(emitted.outputPath)).toEqual(
      Buffer.from("cover-bytes"),
    );

    const second = await syncEmittedAssetsStorage(ctx);
    expect(second?.uploaded).toEqual([]);
    expect(second?.skipped).toEqual([keepKey]);
    expect(second?.deleted).toEqual([]);
  });

  it("dryRun plans uploads and deletes without writing", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-dry-"));
    scratchRoots.push(root);

    const files = createMemoryFiles({
      "anhur/stale-11111111.png": new TextEncoder().encode("stale"),
    });

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "https://cdn.example.com/anhur/",
          storage: {
            enabled: true,
            files,
            prefix: "anhur",
            dryRun: true,
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });
    const source = path.join(root, "fresh.png");
    await writeFile(source, "fresh");
    const emitted = await ctx.emitAsset(source);
    const keepKey = `anhur/${path.basename(emitted.outputPath)}`;

    const result = await syncEmittedAssetsStorage(ctx);
    expect(result?.dryRun).toBe(true);
    expect(result?.uploaded).toEqual([keepKey]);
    expect(result?.deleted).toEqual(["anhur/stale-11111111.png"]);
    expect(files.store.has(keepKey)).toBe(false);
    expect(files.store.has("anhur/stale-11111111.png")).toBe(true);
  });

  it("fails when enabled with a non-absolute base", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-base-"));
    scratchRoots.push(root);

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "/anhur-assets/",
          storage: {
            enabled: true,
            files: createMemoryFiles(),
            prefix: "anhur",
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });

    await expect(syncEmittedAssetsStorage(ctx)).rejects.toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it("fails when prefix is empty", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-prefix-"));
    scratchRoots.push(root);

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "https://cdn.example.com/",
          storage: {
            enabled: true,
            files: createMemoryFiles(),
            prefix: "   ",
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });

    await expect(syncEmittedAssetsStorage(ctx)).rejects.toThrow(/prefix/);
  });

  it("skips prune when no assets were emitted unless pruneEmpty is true", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-empty-"));
    scratchRoots.push(root);

    const files = createMemoryFiles({
      "anhur/keep-me.png": new TextEncoder().encode("keep"),
    });

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "https://cdn.example.com/anhur/",
          storage: {
            enabled: true,
            files,
            prefix: "anhur",
            prune: true,
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });

    const result = await syncEmittedAssetsStorage(ctx);
    expect(result?.pruneSkipped).toBe("empty-emit");
    expect(result?.deleted).toEqual([]);
    expect(files.store.has("anhur/keep-me.png")).toBe(true);
  });

  it("fails when bulk delete reports partial errors", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "storage-delerr-"));
    scratchRoots.push(root);

    const files: AssetStorageClient = {
      async upload() {},
      async exists() {
        return false;
      },
      async delete() {
        return {
          deleted: [],
          errors: [{ key: "anhur/orphan.png", error: new Error("denied") }],
        };
      },
      async *listAll() {
        yield { key: "anhur/orphan.png" };
      },
    };

    const config = defineConfig({
      processors: [
        defineProcessor("assets", {
          dir: ".anhur/assets",
          base: "https://cdn.example.com/anhur/",
          storage: {
            enabled: true,
            files,
            prefix: "anhur",
            prune: true,
          },
        }),
      ],
      content: [
        defineCollection({
          name: "posts",
          directory: "content",
          include: "**/*.md",
          schema: s.object({ title: s.string() }),
        }),
      ],
    });

    const ctx = await createBuildContext(config, {
      rootDir: root,
      configDir: root,
    });
    const source = path.join(root, "fresh.png");
    await writeFile(source, "fresh");
    await ctx.emitAsset(source);

    await expect(syncEmittedAssetsStorage(ctx)).rejects.toThrow(
      /failed to delete/,
    );
  });
});
