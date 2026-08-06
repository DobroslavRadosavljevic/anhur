import { createJiti } from "jiti";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearIntegrationHandlers, getIntegrationHandler } from "@anhur/core";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOramaRegistered } from "../../src/integration";

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  clearIntegrationHandlers();
  ensureOramaRegistered();
});

describe("orama jiti registration", () => {
  it("registers Orama on the host after a jiti config import", async () => {
    clearIntegrationHandlers();
    expect(getIntegrationHandler("orama")).toBeUndefined();

    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "jiti-orama-"));
    scratchRoots.push(root);

    await writeFile(
      path.join(root, "anhur.config.ts"),
      `import { defineCollection, defineConfig } from "@anhur/core";
import { orama } from "@anhur/orama";
import * as z from "zod";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: z.object({ title: z.string(), content: z.string() }),
});

export default defineConfig({
  content: [posts],
  integrations: [
    orama({
      collections: {
        posts: {
          schema: { title: "string" },
          index: (doc) => ({ title: doc.title }),
        },
      },
    }),
  ],
});
`,
    );

    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: true,
      fsCache: false,
      // Force duplicate module graphs (workspace realpath failure mode).
      nativeModules: [],
    });
    await jiti.import(path.join(root, "anhur.config.ts"));

    expect(getIntegrationHandler("orama")?.id).toBe("orama");
  });
});
