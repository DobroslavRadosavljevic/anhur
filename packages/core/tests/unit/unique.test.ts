import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createBuildContext } from "../../src/build-context";
import { defineConfig } from "../../src/config";
import { formatAnhurError } from "../../src/errors";
import { schema as s } from "../../src/schema";
import { validateWithSchema } from "../../src/validate";

describe("s.unique() drafts", () => {
  const schema = s.object({
    slug: s.unique(),
    draft: s.boolean().optional(),
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

  it("does not treat draft documents as unique conflicts", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });

    const draft = await Effect.runPromise(
      validateWithSchema({
        schema,
        input: { slug: "hello", draft: true },
        filePath: "/tmp/content/draft.md",
        id: "draft",
        config,
        buildContext,
        sourceName: "posts",
      }),
    );
    const published = await Effect.runPromise(
      validateWithSchema({
        schema,
        input: { slug: "hello" },
        filePath: "/tmp/content/hello.md",
        id: "hello",
        config,
        buildContext,
        sourceName: "posts",
      }),
    );

    expect(draft.slug).toBe("hello");
    expect(published.slug).toBe("hello");
  });

  it("still fails when two published documents share a unique value", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });

    await Effect.runPromise(
      validateWithSchema({
        schema,
        input: { slug: "hello" },
        filePath: "/tmp/content/a.md",
        id: "a",
        config,
        buildContext,
        sourceName: "posts",
      }),
    );

    await expect(
      Effect.runPromise(
        validateWithSchema({
          schema,
          input: { slug: "hello" },
          filePath: "/tmp/content/b.md",
          id: "b",
          config,
          buildContext,
          sourceName: "posts",
        }),
      ),
    ).rejects.toSatisfy((error) =>
      formatAnhurError(error).includes("duplicate"),
    );
  });
});
