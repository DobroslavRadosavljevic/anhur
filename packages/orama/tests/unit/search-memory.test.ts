import type {
  EmittedModule,
  PluginGenerateContext,
  TransformDocument,
} from "@anhur/core/plugin";
import { describe, expect, it } from "vitest";
import {
  createSearchMemory,
  generateSearchModules,
  type RuntimeOramaOptions,
} from "../../src";

function post(id: string, locale: string, title: string): TransformDocument {
  return Object.freeze({
    title,
    _meta: {
      id,
      locale,
      filePath: `posts/${locale}/${id}.md`,
      relativePath: `${locale}/${id}.md`,
      extension: ".md",
    },
  });
}

const options: RuntimeOramaOptions = {
  collections: {
    posts: {
      schema: { title: "string" },
      index: (document) => ({ title: String(document.title) }),
      store: (document) => ({ title: String(document.title) }),
    },
  },
};

/** Run the plugin's generate step and return the emitted modules by path. */
async function generate(
  documents: readonly TransformDocument[],
  memory: ReturnType<typeof createSearchMemory>,
): Promise<Map<string, string>> {
  const modules: EmittedModule[] = [];
  const context: PluginGenerateContext = {
    projectDir: "/project",
    outputDir: "/project/.anhur/generated",
    mode: "build",
    locales: ["en", "de"],
    defaultLocale: "en",
    sources: [
      { name: "posts", type: "collection", localized: true, documents },
    ],
    emitModule: (module) => {
      modules.push(module);
    },
    emitFile: () => undefined,
    warn: () => undefined,
  };
  await generateSearchModules(options, context, memory);
  return new Map(modules.map((module) => [module.path, module.code]));
}

describe("search index between builds", () => {
  it("builds an index again only for the locale whose documents changed", async () => {
    const memory = createSearchMemory();
    const hello = post("hello", "en", "Hello world");
    const hallo = post("hallo", "de", "Hallo Welt");
    const first = await generate([hello, hallo], memory);
    expect(first.get("search/en.js")).toContain("hello");

    // The same documents: the same modules, not built again.
    const same = await generate([hello, hallo], memory);
    expect(same.get("search/en.js")).toBe(first.get("search/en.js"));
    expect(same.get("search/de.js")).toBe(first.get("search/de.js"));

    // One German document changed: the English index is kept as it is.
    const next = await generate(
      [hello, post("hallo", "de", "Guten Morgen")],
      memory,
    );
    expect(next.get("search/en.js")).toBe(first.get("search/en.js"));
    expect(next.get("search/de.js")).not.toBe(first.get("search/de.js"));
    expect(next.get("search/de.js")).toContain("morg");
    expect(next.get("search/de.js")).not.toContain("welt");
  });

  it("gives the same index with and without a memory", async () => {
    const documents = [
      post("a", "en", "Running shoes"),
      post("b", "en", "Running shoes"),
    ];
    const memory = createSearchMemory();
    await generate(documents, memory);
    const changed = [documents[0]!, post("b", "en", "Running shoes two")];
    const remembered = await generate(changed, memory);
    const fresh = await generate(changed, createSearchMemory());
    expect(remembered.get("search/en.js")).toBe(fresh.get("search/en.js"));
  });
});
