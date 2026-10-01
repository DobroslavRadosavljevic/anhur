import { readdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  build,
  createLogger,
  createServer,
  type Logger,
  type ViteDevServer,
} from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { anhur } from "../../src";
import {
  createProject,
  PNG_1X1,
  type TestProject,
} from "../fixtures/temp-project";

const projects: TestProject[] = [];
const servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const project of projects.splice(0)) await project.remove();
});

const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";

const posts = defineCollection({
  name: "posts",
  directory: "content",
  include: "*.md",
  schema: s.object({ title: s.string(), cover: a.image().optional() }),
});
export default defineConfig({ content: [posts], plugins: [assets()] });
`;

const FILES = {
  "anhur.config.ts": CONFIG,
  "index.html": '<!doctype html><script type="module" src="/main.js"></script>',
  "main.js":
    'import { allPosts } from "anhur/generated";\ndocument.title = allPosts.map((post) => post.title).join(",");\n',
  "content/one.md": "---\ntitle: First post\ncover: ./a.png\n---\n",
  "content/a.png": PNG_1X1,
};

async function until<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const started = performance.now();
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (performance.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 50));
  }
}

type PostsModule = { readonly allPosts: readonly { readonly title: string }[] };

async function loadPosts(server: ViteDevServer): Promise<readonly string[]> {
  const generated = path.join(server.config.root, ".anhur/generated/index.js");
  const module = server.moduleGraph.getModuleById(generated);
  if (module) server.moduleGraph.invalidateModule(module);
  for (const file of await readdir(path.dirname(generated))) {
    const child = server.moduleGraph.getModuleById(
      path.join(path.dirname(generated), file),
    );
    if (child) server.moduleGraph.invalidateModule(child);
  }
  // SAFETY: the generated index exports allPosts (checked by the assertions).
  const loaded = (await server.ssrLoadModule("anhur/generated")) as PostsModule;
  return loaded.allPosts.map((post) => post.title);
}

describe("vite build", () => {
  it("builds content, resolves anhur/generated and copies assets into the client output", async () => {
    const project = await createProject({
      ...FILES,
      ".anhur/assets/old-0123456789abcdef.png": "stale",
      ".anhur/assets/.anhur-assets.json": JSON.stringify({
        files: ["old-0123456789abcdef.png"],
      }),
    });
    projects.push(project);
    await build({
      root: project.dir,
      logLevel: "silent",
      plugins: [anhur()],
      build: { minify: false },
    });
    const bundles = await readdir(project.path("dist/assets"));
    const script = bundles.find((file) => file.endsWith(".js")) ?? "";
    expect(
      await readFile(project.path(`dist/assets/${script}`), "utf8"),
    ).toContain("First post");
    const copied = await readdir(project.path("dist/anhur-assets"));
    expect(copied).toEqual([expect.stringMatching(/^a-[0-9a-f]{16}\.png$/)]);
  });

  it("fails the build with the diagnostics", async () => {
    const project = await createProject({
      ...FILES,
      "content/one.md": "---\ntitle: 1\n---\n",
    });
    projects.push(project);
    await expect(
      build({ root: project.dir, logLevel: "silent", plugins: [anhur()] }),
    ).rejects.toThrow(/content\/one\.md/);
  });
});

type RecordingLogger = {
  readonly logger: Logger;
  readonly lines: string[];
};

/** A logger that records Anhur's info lines. */
function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const logger = createLogger("silent");
  logger.info = (message) => {
    lines.push(message);
  };
  return { logger, lines };
}

describe("vite build --watch", () => {
  it("runs one content build per edit, not one per Rollup rebuild", async () => {
    const project = await createProject(FILES);
    projects.push(project);
    const { logger, lines } = recordingLogger();
    const watcher = await build({
      root: project.dir,
      customLogger: logger,
      plugins: [anhur()],
      build: { minify: false, watch: {} },
    });
    if (!("on" in watcher)) throw new Error("expected a watcher");
    let ends = 0;
    watcher.on("event", (event) => {
      if (event.code === "END") ends += 1;
      if (event.code === "BUNDLE_END" || event.code === "ERROR")
        void event.result?.close();
    });
    try {
      await until(async () => (ends >= 1 ? true : undefined));
      await new Promise((done) => setTimeout(done, 1000));
      const anhurBuilds = () =>
        lines.filter((line) => /\[anhur\] (?:built|rebuilt)/.test(line)).length;
      const before = anhurBuilds();
      const endsBefore = ends;
      await project.write("content/one.md", "---\ntitle: Edited\n---\n");
      await until(async () => (ends > endsBefore ? true : undefined));
      await new Promise((done) => setTimeout(done, 1500));
      expect(anhurBuilds() - before).toBe(1);
      expect(
        await readFile(project.path(".anhur/generated/allPosts.js"), "utf8"),
      ).toContain("Edited");
    } finally {
      await watcher.close();
    }
  });
});

describe("vite dev", () => {
  it("serves assets, rebuilds on change and recovers from errors without restarting", async () => {
    const project = await createProject(FILES);
    projects.push(project);
    const server = await createServer({
      root: project.dir,
      logLevel: "silent",
      plugins: [anhur()],
      server: { middlewareMode: true, ws: false },
    });
    servers.push(server);

    expect(await loadPosts(server)).toEqual(["First post"]);

    const http = createHttpServer(server.middlewares);
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    try {
      // SAFETY: listen() on a TCP port gives an AddressInfo.
      const { port } = http.address() as AddressInfo;
      const asset = (await readdir(project.path(".anhur/assets"))).find(
        (file) => file.endsWith(".png"),
      );
      const response = await fetch(
        `http://127.0.0.1:${port}/anhur-assets/${asset}`,
      );
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_1X1);
    } finally {
      await new Promise((done) => http.close(done));
    }

    await project.write("content/one.md", "---\ntitle: 1\n---\n");
    await project.write("content/two.md", "---\ntitle: Second\n---\n");
    await new Promise((done) => setTimeout(done, 500));
    expect(await loadPosts(server)).toEqual(["First post"]);

    await project.write("content/one.md", "---\ntitle: Fixed\n---\n");
    const titles = await until(async () => {
      const current = await loadPosts(server);
      return current.length === 2 ? current : undefined;
    });
    expect([...titles].sort()).toEqual(["Fixed", "Second"]);
  });

  it("keeps rebuilding after server.restart() with an inline plugin", async () => {
    const project = await createProject(FILES);
    projects.push(project);
    const server = await createServer({
      root: project.dir,
      logLevel: "silent",
      plugins: [anhur()],
      server: { middlewareMode: true, ws: false },
    });
    servers.push(server);
    expect(await loadPosts(server)).toEqual(["First post"]);
    await server.restart();
    await project.write("content/one.md", "---\ntitle: After restart\n---\n");
    expect(
      await until(async () => {
        const current = await loadPosts(server);
        return current[0] === "After restart" ? current : undefined;
      }),
    ).toEqual(["After restart"]);
  });

  it("rebuilds for changes made while the first build runs", async () => {
    const slow = CONFIG.replace(
      "title: s.string()",
      "title: s.string().transform(async (value) => { await new Promise((done) => setTimeout(done, 1500)); return value; })",
    );
    const project = await createProject({ ...FILES, "anhur.config.ts": slow });
    projects.push(project);
    const starting = createServer({
      root: project.dir,
      logLevel: "silent",
      plugins: [anhur()],
      server: { middlewareMode: true, ws: false },
    });
    await new Promise((done) => setTimeout(done, 800));
    await project.write("content/one.md", "---\ntitle: Early edit\n---\n");
    const server = await starting;
    servers.push(server);
    expect(
      await until(async () => {
        const current = await loadPosts(server);
        return current[0] === "Early edit" ? current : undefined;
      }, 20_000),
    ).toEqual(["Early edit"]);
  });

  it("starts even when the first build fails", async () => {
    const project = await createProject({
      ...FILES,
      "anhur.config.ts": "export default {",
    });
    projects.push(project);
    const server = await createServer({
      root: project.dir,
      logLevel: "silent",
      plugins: [anhur()],
      server: { middlewareMode: true, ws: false },
    });
    servers.push(server);
    await project.write("anhur.config.ts", CONFIG);
    expect(
      await until(async () => {
        const current = await loadPosts(server);
        return current.length > 0 ? current : undefined;
      }),
    ).toEqual(["First post"]);
  });
});
