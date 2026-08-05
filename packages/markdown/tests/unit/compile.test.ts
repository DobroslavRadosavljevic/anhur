import { describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineConfig,
  schema as s,
  withBuildContext,
  withDocumentMeta,
} from "@anhur/core";
import { compileMarkdown } from "../../src/compile";
import { markdown, schema as md } from "../../src/schema";

describe("compileMarkdown", () => {
  it("compiles markdown to HTML", async () => {
    const html = await compileMarkdown("Hello **world**");
    expect(html).toContain("<strong>world</strong>");
  });
});

describe("schema.markdown", () => {
  it("compiles when markdown processor is registered", async () => {
    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
      processors: [markdown({ gfm: true })],
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
      rootDir: "/tmp",
      configDir: "/tmp",
    });

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: "/tmp/page.md",
          content: "Hi **there**",
          sourceName: "pages",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Page" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toContain("<strong>there</strong>");
    }
  });

  it("fails when markdown processor is missing", async () => {
    const zodSchema = s.object({
      title: s.string(),
      body: md.markdown(),
    });
    const config = defineConfig({
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
      rootDir: "/tmp",
      configDir: "/tmp",
    });

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: "/tmp/page.md",
            content: "Hi",
            sourceName: "pages",
            config,
          },
          () => zodSchema.parseAsync({ title: "Page" }),
        ),
      ),
    ).rejects.toThrow(/requires a Markdown processor/);
  });
});
