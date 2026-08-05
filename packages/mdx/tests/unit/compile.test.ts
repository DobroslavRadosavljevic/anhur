import { describe, expect, it } from "vitest";
import {
  createBuildContext,
  defineConfig,
  schema as s,
  withBuildContext,
  withDocumentMeta,
} from "@anhur/core";
import { compileMdx } from "../../src/compile";
import { mdx, schema as m } from "../../src/schema";

describe("compileMdx", () => {
  it("compiles markdown to a function-body string", async () => {
    const code = await compileMdx("# Hello\n\nWorld");
    expect(code).toContain("function");
    expect(code).toContain("Hello");
  });

  it("can disable gfm", async () => {
    const code = await compileMdx("~~strike~~", { gfm: false });
    expect(typeof code).toBe("string");
  });
});

describe("schema.mdx", () => {
  it("compiles when mdx processor is registered", async () => {
    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
      processors: [mdx({ gfm: true })],
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
      rootDir: "/tmp",
      configDir: "/tmp",
    });

    const result = await withBuildContext(buildContext, () =>
      withDocumentMeta(
        {
          path: "/tmp/hello.mdx",
          content: "Hello **world**",
          sourceName: "posts",
          config,
        },
        () => zodSchema.safeParseAsync({ title: "Hi" }),
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toContain("function");
    }
  });

  it("fails when mdx processor is missing", async () => {
    const zodSchema = s.object({
      title: s.string(),
      body: m.mdx(),
    });
    const config = defineConfig({
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
      rootDir: "/tmp",
      configDir: "/tmp",
    });

    await expect(
      withBuildContext(buildContext, () =>
        withDocumentMeta(
          {
            path: "/tmp/hello.mdx",
            content: "Hello",
            sourceName: "posts",
            config,
          },
          () => zodSchema.parseAsync({ title: "Hi" }),
        ),
      ),
    ).rejects.toThrow(/requires an MDX processor/);
  });
});
