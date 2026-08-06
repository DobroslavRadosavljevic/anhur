import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { anhur } from "../../src/index";

const fixtureBasic = path.join(import.meta.dirname, "../fixtures/basic");
const scratchRoot = path.join(import.meta.dirname, "../.temp");

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

async function readGenerated(root: string, file = "allPosts.js") {
  return readFile(path.join(root, ".anhur/generated", file), "utf8");
}

async function generatedMtime(root: string, file = "allPosts.js") {
  const info = await stat(path.join(root, ".anhur/generated", file));
  return info.mtimeMs;
}

function trackFullReloads(server: ViteDevServer) {
  const reloads: ReloadPayload[] = [];
  const original = server.ws.send.bind(server.ws);
  server.ws.send = ((payload: ReloadPayload) => {
    if (payload?.type === "full-reload") {
      reloads.push(payload);
    }
    return original(payload as never);
  }) as typeof server.ws.send;
  return reloads;
}

async function createTempProject() {
  // Keep temps under this package so jiti can resolve workspace `@anhur/*`.
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, "dev-"));
  await cp(fixtureBasic, root, { recursive: true });
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
    async () => {
      try {
        const code = await readGenerated(root);
        return code.includes('"title": "One"') ? code : false;
      } catch {
        return false;
      }
    },
    { label: "initial generated posts" },
  );
  // Let chokidar settle after the initial build write storm.
  await sleep(200);
  reloads.length = 0;
  return { server, reloads };
}

describe("anhur vite plugin dev rebuild", () => {
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

  it("rebuilds and full-reloads when a content file changes", async () => {
    const { root, reloads } = await setup();
    const postPath = path.join(root, "content/posts/one.md");

    await writeFile(postPath, "---\ntitle: Updated One\n---\nBody\n");

    await waitFor(
      async () => {
        const code = await readGenerated(root);
        return code.includes('"title": "Updated One"') ? code : false;
      },
      { label: "content change in generated output" },
    );

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after content change",
    });
  });

  it("rebuilds when a new content file is added", async () => {
    const { root, reloads } = await setup();

    await writeFile(
      path.join(root, "content/posts/two.md"),
      "---\ntitle: Two\n---\nSecond\n",
    );

    await waitFor(
      async () => {
        const code = await readGenerated(root);
        return code.includes('"title": "Two"') &&
          code.includes('"title": "One"')
          ? code
          : false;
      },
      { label: "new content file in generated output" },
    );

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after add",
    });
  });

  it("rebuilds when a content file is deleted", async () => {
    const { root, reloads } = await setup();

    await writeFile(
      path.join(root, "content/posts/two.md"),
      "---\ntitle: Two\n---\nSecond\n",
    );
    await waitFor(
      async () => {
        const code = await readGenerated(root);
        return code.includes('"title": "Two"') ? code : false;
      },
      { label: "two.md present before delete" },
    );
    reloads.length = 0;

    await rm(path.join(root, "content/posts/two.md"));

    await waitFor(
      async () => {
        const code = await readGenerated(root);
        return code.includes('"title": "One"') &&
          !code.includes('"title": "Two"')
          ? code
          : false;
      },
      { label: "deleted content removed from generated output" },
    );

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after delete",
    });
  });

  it("rebuilds and full-reloads when anhur.config.ts changes", async () => {
    const { root, reloads } = await setup();
    const configPath = path.join(root, "anhur.config.ts");

    await writeFile(
      configPath,
      `import { defineCollection, defineConfig } from "@anhur/core";
import * as z from "zod";

export default defineConfig({
  content: [
    defineCollection({
      name: "articles",
      directory: "content/posts",
      include: "**/*.md",
      schema: z.object({
        title: z.string(),
        content: z.string(),
      }),
    }),
  ],
});
`,
    );

    await waitFor(
      async () => {
        try {
          const index = await readFile(
            path.join(root, ".anhur/generated/index.js"),
            "utf8",
          );
          return index.includes("allArticles") && !index.includes("allPosts")
            ? index
            : false;
        } catch {
          return false;
        }
      },
      { label: "config rename reflected in generated index" },
    );

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after config change",
    });
  });

  it("starts watching a newly configured content directory", async () => {
    const { root, reloads } = await setup();
    await mkdir(path.join(root, "content/pages"), { recursive: true });

    await writeFile(
      path.join(root, "anhur.config.ts"),
      `import { defineCollection, defineConfig } from "@anhur/core";
import * as z from "zod";

const schema = z.object({
  title: z.string(),
  content: z.string(),
});

export default defineConfig({
  content: [
    defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema,
    }),
    defineCollection({
      name: "pages",
      directory: "content/pages",
      include: "**/*.md",
      schema,
    }),
  ],
});
`,
    );

    await waitFor(
      async () => {
        try {
          const index = await readFile(
            path.join(root, ".anhur/generated/index.js"),
            "utf8",
          );
          return index.includes("allPages") ? index : false;
        } catch {
          return false;
        }
      },
      { label: "pages collection after config change" },
    );
    reloads.length = 0;

    await writeFile(
      path.join(root, "content/pages/about.md"),
      "---\ntitle: About\n---\nHi\n",
    );

    await waitFor(
      async () => {
        try {
          const code = await readFile(
            path.join(root, ".anhur/generated/allPages.js"),
            "utf8",
          );
          return code.includes('"title": "About"') ? code : false;
        } catch {
          return false;
        }
      },
      { label: "new directory content after watch sync" },
    );

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after new-directory content",
    });
  });

  it("does not rebuild for unrelated file changes", async () => {
    const { root, reloads } = await setup();
    const before = await generatedMtime(root);

    await writeFile(path.join(root, "NOTES.txt"), "unrelated\n");
    await sleep(800);

    const after = await generatedMtime(root);
    expect(after).toBe(before);
    expect(reloads.length).toBe(0);
  });

  it("recovers after a failed content build when the file is fixed", async () => {
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
      { label: "anhur error after invalid content" },
    );

    reloads.length = 0;
    await writeFile(postPath, "---\ntitle: Fixed\n---\nOk\n");

    await waitFor(
      async () => {
        const code = await readGenerated(root);
        return code.includes('"title": "Fixed"') ? code : false;
      },
      { label: "recovery after fixing content" },
    );

    await waitFor(async () => (reloads.length > 0 ? reloads : false), {
      label: "full-reload after recovery",
    });
  });
});
