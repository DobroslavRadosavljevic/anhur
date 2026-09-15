import { mkdtemp, rm } from "node:fs/promises";
import type { Root } from "mdast";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin, PluggableList } from "unified";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineConfig,
  schema as s,
  withBuildContext,
  withDocumentMeta,
} from "@anhur/core";
import { markdown, schema as md } from "../../src/schema";

const remarkAppend: Plugin<[string], Root> = (text) => (tree) => {
  tree.children.push({
    type: "paragraph",
    children: [{ type: "text", value: text }],
  });
};

describe("markdown persist cache identity", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function compileWithPlugins(plugins: PluggableList) {
    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      cacheDir: ".anhur/cache",
      processors: [markdown({ gfm: true, remarkPlugins: plugins })],
      content: [
        {
          type: "collection",
          name: "pages",
          typeName: "Pages",
          directory: "content",
          include: "**/*.md",
          schema: zodSchema,
        },
      ],
    });
    const buildContext = await createBuildContext(config, {
      rootDir: dir,
      configDir: dir,
    });
    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: path.join(dir, "hello.md"),
          content: "Hello",
          sourceName: "pages",
          config,
        },
        () => zodSchema.parseAsync({ title: "Hi" }),
      ),
    );
    return result.body;
  }

  it("invalidates when unified plugin tuple options change", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-persist-"));
    const one = await compileWithPlugins([[remarkAppend, "ONE"]]);
    expect(one).toContain("ONE");
    expect(one).not.toContain("TWO");

    const two = await compileWithPlugins([[remarkAppend, "TWO"]]);
    expect(two).toContain("TWO");
    expect(two).not.toContain("ONE");
  });

  it("invalidates when a different named plugin replaces another at the same count", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-md-persist-swap-"));
    const remarkAlpha: Plugin<[], Root> = () => (tree) => {
      tree.children.push({
        type: "paragraph",
        children: [{ type: "text", value: "alpha" }],
      });
    };
    const remarkBeta: Plugin<[], Root> = () => (tree) => {
      tree.children.push({
        type: "paragraph",
        children: [{ type: "text", value: "beta" }],
      });
    };

    const alpha = await compileWithPlugins([remarkAlpha]);
    expect(alpha).toContain("alpha");
    expect(alpha).not.toContain("beta");

    const beta = await compileWithPlugins([remarkBeta]);
    expect(beta).toContain("beta");
    expect(beta).not.toContain("alpha");
  });
});
