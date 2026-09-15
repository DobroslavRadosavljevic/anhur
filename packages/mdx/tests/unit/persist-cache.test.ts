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
import { mdx, schema as m } from "../../src/schema";

const remarkAppend: Plugin<[string], Root> = (text) => (tree) => {
  tree.children.push({
    type: "paragraph",
    children: [{ type: "text", value: text }],
  });
};

describe("mdx persist cache identity", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function compileWithPlugins(plugins: PluggableList) {
    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
      cacheDir: ".anhur/cache",
      processors: [mdx({ gfm: true, remarkPlugins: plugins })],
      content: [
        {
          type: "collection",
          name: "posts",
          typeName: "Posts",
          directory: "content",
          include: "**/*.mdx",
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
          path: path.join(dir, "hello.mdx"),
          content: "Hello",
          sourceName: "posts",
          config,
        },
        () => zodSchema.parseAsync({ title: "Hi" }),
      ),
    );
    return result.body;
  }

  it("invalidates when unified plugin tuple options change", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anhur-mdx-persist-"));
    const one = await compileWithPlugins([[remarkAppend, "ONE"]]);
    expect(one).toContain("ONE");
    expect(one).not.toContain("TWO");

    const two = await compileWithPlugins([[remarkAppend, "TWO"]]);
    expect(two).toContain("TWO");
    expect(two).not.toContain("ONE");
  });
});
