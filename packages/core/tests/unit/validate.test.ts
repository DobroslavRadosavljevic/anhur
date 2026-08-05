import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createBuildContext } from "../../src/build-context";
import { defineConfig } from "../../src/config";
import { schema as s } from "../../src/schema";
import { validateWithSchema } from "../../src/validate";

describe("validateWithSchema", () => {
  const zodSchema = s.object({
    title: s.string(),
    content: s.string(),
  });
  const config = defineConfig({
    content: [
      {
        type: "collection",
        name: "posts",
        typeName: "Post",
        directory: "content",
        include: "**/*.md",
        schema: zodSchema,
      },
    ],
  });

  it("accepts valid input", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });
    const data = await Effect.runPromise(
      validateWithSchema({
        schema: zodSchema,
        input: { title: "Hi", content: "Body" },
        filePath: "/tmp/a.md",
        id: "a",
        config,
        buildContext,
        content: "Body",
        sourceName: "posts",
      }),
    );
    expect(data).toEqual({ title: "Hi", content: "Body" });
  });

  it("fails on missing fields", async () => {
    const buildContext = await createBuildContext(config, {
      rootDir: "/tmp",
      configDir: "/tmp",
    });
    await expect(
      Effect.runPromise(
        validateWithSchema({
          schema: zodSchema,
          input: { title: "Hi" },
          filePath: "/tmp/a.md",
          id: "a",
          config,
          buildContext,
          sourceName: "posts",
        }),
      ),
    ).rejects.toThrow();
  });
});
