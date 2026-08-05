import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createBuildContext } from "../../src/build-context";
import { defineConfig } from "../../src/config";
import { schema as s } from "../../src/schema";
import { validateWithSchema } from "../../src/validate";

describe("s.slug()", () => {
  const schema = s.object({
    slug: s.slug(),
  });
  const config = defineConfig({
    content: [
      {
        type: "collection",
        name: "posts",
        typeName: "Post",
        directory: "content",
        include: "**/*.md",
        schema,
      },
    ],
  });

  it("derives slug from document id when omitted", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });
    const data = await Effect.runPromise(
      validateWithSchema({
        schema,
        input: {},
        filePath: "/tmp/content/hello-world.md",
        id: "hello-world",
        config,
        buildContext,
        sourceName: "posts",
      }),
    );
    expect(data.slug).toBe("hello-world");
  });

  it("keeps an explicit slug", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });
    const data = await Effect.runPromise(
      validateWithSchema({
        schema,
        input: { slug: "custom" },
        filePath: "/tmp/content/hello-world.md",
        id: "hello-world",
        config,
        buildContext,
        sourceName: "posts",
      }),
    );
    expect(data.slug).toBe("custom");
  });

  it("rejects invalid slug format", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });
    await expect(
      Effect.runPromise(
        validateWithSchema({
          schema,
          input: { slug: "Bad Slug!" },
          filePath: "/tmp/content/hello.md",
          id: "hello",
          config,
          buildContext,
          sourceName: "posts",
        }),
      ),
    ).rejects.toThrow();
  });
});
