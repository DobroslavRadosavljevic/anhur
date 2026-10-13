import type {
  EmittedModule,
  PluginGenerateContext,
  TransformDocument,
} from "@anhur/core/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSearchMemory,
  generateSearchModules,
  type RuntimeOramaOptions,
  type SearchMemory,
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

/** Documents `index()` ran for since the last `takeRows()`, as `locale/id`. */
const rows: string[] = [];

/**
 * The rows the index builds made since the last call. The plugin calls
 * `index()` once for each document of an index it builds, and not at all
 * for an index it keeps.
 */
function takeRows(): string[] {
  return rows.splice(0);
}

const options: RuntimeOramaOptions = {
  collections: {
    posts: {
      schema: { title: "string" },
      index: (document) => {
        rows.push(`${document._meta.locale ?? ""}/${document._meta.id}`);
        return { title: String(document.title) };
      },
      store: (document) => ({ title: String(document.title) }),
    },
  },
};

/** Run the plugin's generate step and return the emitted modules by path. */
async function generate(
  documents: readonly TransformDocument[],
  memory: SearchMemory,
  mode: PluginGenerateContext["mode"] = "dev",
): Promise<Map<string, string>> {
  const modules: EmittedModule[] = [];
  const context: PluginGenerateContext = {
    projectDir: "/project",
    outputDir: "/project/.anhur/generated",
    mode,
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

afterEach(() => {
  rows.length = 0;
  vi.restoreAllMocks();
});

describe("search index between builds", () => {
  // Catches: an index built again for nothing (the memory does not work),
  // an index kept though its documents changed (a stale search), and a
  // kept index that is not emitted (the module would leave the output).
  it("builds an index again only when a document of its locale changed, was added or was removed", async () => {
    const memory = createSearchMemory();
    const hello = post("hello", "en", "Hello world");
    const hallo = post("hallo", "de", "Hallo Welt");
    const first = await generate([hello, hallo], memory);
    expect(takeRows()).toEqual(["en/hello", "de/hallo"]);

    // The same documents: no index is built, the same modules are emitted.
    const same = await generate([hello, hallo], memory);
    expect(takeRows()).toEqual([]);
    expect(same.get("search/en.js")).toBe(first.get("search/en.js"));
    expect(same.get("search/de.js")).toBe(first.get("search/de.js"));

    // A German document changed: only the German index is built.
    const morgen = post("hallo", "de", "Guten Morgen");
    const edited = await generate([hello, morgen], memory);
    expect(takeRows()).toEqual(["de/hallo"]);
    expect(edited.get("search/en.js")).toBe(first.get("search/en.js"));
    expect(edited.get("search/de.js")).toContain("Guten Morgen");
    expect(edited.get("search/de.js")).not.toContain("Hallo Welt");

    // An English document was added: only the English index is built.
    const bye = post("bye", "en", "Goodbye");
    const added = await generate([hello, bye, morgen], memory);
    expect(takeRows()).toEqual(["en/hello", "en/bye"]);
    expect(added.get("search/en.js")).toContain("Goodbye");
    expect(added.get("search/de.js")).toBe(edited.get("search/de.js"));

    // An English document was removed: only the English index is built.
    const removed = await generate([bye, morgen], memory);
    expect(takeRows()).toEqual(["en/bye"]);
    expect(removed.get("search/en.js")).not.toContain("Hello world");
    expect(removed.get("search/de.js")).toBe(edited.get("search/de.js"));
  });

  // Catches: remembered tokens that change the index (wrong words for a
  // text, or tokens of one document used for another).
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

describe("tokens of indexed text between builds", () => {
  /**
   * The texts split into words since the last call. The tokenizer gives
   * each text it has no tokens for to `Intl.Segmenter` once.
   */
  function spyOnSplits(): () => unknown[] {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    return () => {
      const texts = segment.mock.calls.map(([text]) => text);
      segment.mockClear();
      return texts;
    };
  }

  // Catches: a dev session that splits every text again on each build (the
  // memory does not work), and a memory that keeps the text of documents
  // that are gone (it would grow for as long as the dev server runs).
  it("splits a text once in a dev session and forgets a text that left the index", async () => {
    const takeSplits = spyOnSplits();
    const memory = createSearchMemory();
    const alpha = post("a", "en", "Alpha text");
    const beta = post("b", "en", "Beta text");
    await generate([alpha, beta], memory, "dev");
    expect(takeSplits()).toEqual(["Alpha text", "Beta text"]);

    // The index is built again, but only the new text is split.
    await generate([alpha, post("b", "en", "Gamma text")], memory, "dev");
    expect(takeSplits()).toEqual(["Gamma text"]);

    // "Beta text" left the index in the last build, so it was not kept.
    await generate([alpha, beta], memory, "dev");
    expect(takeSplits()).toEqual(["Beta text"]);
  });

  // Catches: `anhur build` holding every indexed text and its tokens in
  // memory, where no later build can use them.
  it("keeps no tokens in build mode", async () => {
    const takeSplits = spyOnSplits();
    const memory = createSearchMemory();
    const alpha = post("a", "en", "Alpha text");
    await generate([alpha, post("b", "en", "Beta text")], memory, "build");
    expect(takeSplits()).toEqual(["Alpha text", "Beta text"]);

    await generate([alpha, post("b", "en", "Gamma text")], memory, "build");
    expect(takeSplits()).toEqual(["Alpha text", "Gamma text"]);
  });
});
