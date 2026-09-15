import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSearcher,
  isAnhurOramaIndex,
  type AnhurOramaIndex,
} from "@anhur/orama/client";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { anhur } from "../../src/index";

const fixtureOrama = path.join(import.meta.dirname, "../fixtures/orama-basic");
const scratchRoot = path.join(import.meta.dirname, "../.temp");
const ORAMA_INDEX = path.join(".anhur", "generated", "search", "orama.json");

type ReloadPayload = { type?: string };

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | false | null | undefined>,
  {
    timeoutMs = 15_000,
    intervalMs = 75,
    label = "condition",
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isFullReload<T>(payload: T): payload is T & { type: "full-reload" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    payload.type === "full-reload"
  );
}

function trackFullReloads(server: ViteDevServer) {
  const reloads: ReloadPayload[] = [];
  const original = server.ws.send.bind(server.ws);
  type WsSend = ViteDevServer["ws"]["send"];
  // SAFETY: wrapper only inspects full-reload payloads; remaining overloads match original send.
  server.ws.send = ((payload: Parameters<WsSend>[0]) => {
    if (isFullReload(payload)) {
      reloads.push(payload);
    }
    return original(payload);
  }) as WsSend;
  return reloads;
}

async function readOramaIndex(root: string): Promise<AnhurOramaIndex | null> {
  try {
    const raw = await readFile(path.join(root, ORAMA_INDEX), "utf8");
    const snapshot = JSON.parse(raw);
    if (!isAnhurOramaIndex(snapshot)) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function indexHasTitle(root: string, title: string): Promise<boolean> {
  const snapshot = await readOramaIndex(root);
  if (!snapshot) return false;
  return snapshot.documents.some((doc) => doc.title === title);
}

async function searchTitle(
  root: string,
  term: string,
): Promise<{ count: number; titles: string[] } | null> {
  const snapshot = await readOramaIndex(root);
  if (!snapshot) return null;
  const searcher = await createSearcher(snapshot);
  const result = await searcher.search({ term });
  return {
    count: result.count,
    titles: result.hits.map((hit) => String(hit.store.title ?? "")),
  };
}

async function createTempProject() {
  // Keep temps under this package so jiti can resolve workspace `@anhur/*`.
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, "orama-dev-"));
  await cp(fixtureOrama, root, { recursive: true });
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><body></body></html>\n",
  );
  return root;
}

async function startAnhurDev(root: string) {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "error",
    appType: "custom",
    server: {
      middlewareMode: true,
      watch: {
        usePolling: true,
        interval: 50,
      },
    },
    plugins: [anhur()],
  });
  const reloads = trackFullReloads(server);
  await waitFor(
    async () => ((await indexHasTitle(root, "One")) ? true : false),
    { label: "initial Orama index with One" },
  );
  // Let chokidar settle after the initial build write storm.
  await sleep(200);
  reloads.length = 0;
  return { server, reloads };
}

describe("anhur vite plugin Orama rebuild", () => {
  const roots: string[] = [];
  const servers: ViteDevServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function setup() {
    const root = await createTempProject();
    roots.push(root);
    const ctx = await startAnhurDev(root);
    servers.push(ctx.server);
    return { root, ...ctx };
  }

  it("writes a searchable Orama index on initial Vite start", async () => {
    const { root } = await setup();

    const snapshot = await readOramaIndex(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(2);
    expect(snapshot?.collections).toEqual(["posts"]);
    expect(snapshot?.documents).toHaveLength(1);

    const hits = await searchTitle(root, "One");
    expect(hits?.count).toBeGreaterThan(0);
    expect(hits?.titles).toContain("One");
  });

  it("regenerates a valid searchable Orama index when content changes", async () => {
    const { root, reloads } = await setup();
    const postPath = path.join(root, "content/posts/one.md");

    await writeFile(postPath, "---\ntitle: Updated One\n---\nBody\n");

    await waitFor(
      async () => ((await indexHasTitle(root, "Updated One")) ? true : false),
      { label: "Orama index after content title change" },
    );

    const snapshot = await readOramaIndex(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.documents).toHaveLength(1);
    expect(snapshot?.documents.some((doc) => doc.title === "One")).toBe(false);

    const hits = await searchTitle(root, "Updated");
    expect(hits?.count).toBeGreaterThan(0);
    expect(hits?.titles).toContain("Updated One");
    expect(hits?.titles).not.toContain("One");

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after Orama content change",
    });
  });

  it("adds new documents to the Orama index when content files are added", async () => {
    const { root, reloads } = await setup();

    await writeFile(
      path.join(root, "content/posts/two.md"),
      "---\ntitle: Two\n---\nSecond\n",
    );

    await waitFor(
      async () => {
        const snapshot = await readOramaIndex(root);
        if (!snapshot) return false;
        const titles = snapshot.documents.map((doc) => doc.title);
        return titles.includes("One") && titles.includes("Two")
          ? snapshot
          : false;
      },
      { label: "Orama index after adding two.md" },
    );

    const oneHits = await searchTitle(root, "One");
    const twoHits = await searchTitle(root, "Two");
    expect(oneHits?.count).toBeGreaterThan(0);
    expect(twoHits?.count).toBeGreaterThan(0);
    expect(twoHits?.titles).toContain("Two");

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after Orama add",
    });
  });

  it("removes documents from the Orama index when content files are deleted", async () => {
    const { root, reloads } = await setup();

    await writeFile(
      path.join(root, "content/posts/two.md"),
      "---\ntitle: Two\n---\nSecond\n",
    );
    await waitFor(
      async () => ((await indexHasTitle(root, "Two")) ? true : false),
      { label: "Two present in Orama before delete" },
    );
    reloads.length = 0;

    await rm(path.join(root, "content/posts/two.md"));

    await waitFor(
      async () => {
        const snapshot = await readOramaIndex(root);
        if (!snapshot) return false;
        const titles = snapshot.documents.map((doc) => doc.title);
        return titles.includes("One") && !titles.includes("Two")
          ? snapshot
          : false;
      },
      { label: "Two removed from Orama after delete" },
    );

    const twoHits = await searchTitle(root, "Two");
    expect(twoHits?.count ?? 0).toBe(0);

    const oneHits = await searchTitle(root, "One");
    expect(oneHits?.count).toBeGreaterThan(0);

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after Orama delete",
    });
  });

  it("keeps a valid Orama index across rapid successive content edits", async () => {
    const { root, reloads } = await setup();
    const postPath = path.join(root, "content/posts/one.md");

    await writeFile(postPath, "---\ntitle: Draft A\n---\nBody\n");
    await writeFile(postPath, "---\ntitle: Draft B\n---\nBody\n");
    await writeFile(postPath, "---\ntitle: Final Title\n---\nBody\n");

    await waitFor(
      async () => ((await indexHasTitle(root, "Final Title")) ? true : false),
      { label: "Orama index settles on final title" },
    );

    const snapshot = await readOramaIndex(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.documents).toHaveLength(1);
    expect(snapshot?.documents[0]?.title).toBe("Final Title");

    const hits = await searchTitle(root, "Final");
    expect(hits?.count).toBeGreaterThan(0);
    expect(hits?.titles).toContain("Final Title");

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after rapid Orama edits",
    });
  });

  it("recovers a searchable Orama index after a failed content build is fixed", async () => {
    const { root, reloads, server } = await setup();
    const errors: string[] = [];
    const originalError = server.config.logger.error.bind(server.config.logger);
    server.config.logger.error = (msg, options) => {
      errors.push(String(msg));
      return originalError(msg, options);
    };

    const postPath = path.join(root, "content/posts/one.md");
    await writeFile(postPath, "---\n---\nMissing title\n");

    await waitFor(
      async () => (errors.some((e) => e.includes("[anhur]")) ? errors : false),
      { label: "anhur error after invalid content with Orama" },
    );

    reloads.length = 0;
    await writeFile(postPath, "---\ntitle: Fixed Search\n---\nOk\n");

    await waitFor(
      async () => ((await indexHasTitle(root, "Fixed Search")) ? true : false),
      { label: "Orama recovery after fixing content" },
    );

    const hits = await searchTitle(root, "Fixed");
    expect(hits?.count).toBeGreaterThan(0);
    expect(hits?.titles).toContain("Fixed Search");

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after Orama recovery",
    });
  });

  it("keeps the previous searchable Orama index when a content rebuild fails", async () => {
    const { root, reloads, server } = await setup();
    const before = await readOramaIndex(root);
    expect(before).not.toBeNull();
    expect(before?.documents.some((doc) => doc.title === "One")).toBe(true);

    const errors: string[] = [];
    const originalError = server.config.logger.error.bind(server.config.logger);
    server.config.logger.error = (msg, options) => {
      errors.push(String(msg));
      return originalError(msg, options);
    };

    await writeFile(
      path.join(root, "content/posts/one.md"),
      "---\n---\nMissing title\n",
    );

    await waitFor(
      async () => (errors.some((e) => e.includes("[anhur]")) ? errors : false),
      { label: "anhur error while preserving Orama" },
    );

    await sleep(300);

    const after = await readOramaIndex(root);
    expect(after).not.toBeNull();
    expect(after).toEqual(before);

    const hits = await searchTitle(root, "One");
    expect(hits?.count).toBeGreaterThan(0);
    expect(hits?.titles).toContain("One");
    expect(reloads.length).toBe(0);
  });
});
