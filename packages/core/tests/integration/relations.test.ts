import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "../../src/index";

const fixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

describe("transform context + references", () => {
  it("joins via transform.documents() and embeds s.reference()", async () => {
    const result = await build({
      rootDir: path.join(fixturesRoot, "relations"),
    });

    const postsBuilt = result.built.find((b) => b.source.name === "posts");
    expect(postsBuilt).toBeDefined();
    const post = postsBuilt!.documents[0]!;
    expect(post.data.slug).toBe("hello");
    expect(post.data.authorNameFromContext).toBe("Ada");
    expect(post.data.author).toMatchObject({
      name: "Ada",
      role: "Engineer",
      _meta: { id: "ada" },
    });
  });

  it("fails when s.reference() target is missing", async () => {
    await expect(
      build({
        rootDir: path.join(fixturesRoot, "relations-missing"),
      }),
    ).rejects.toMatchObject({
      _tag: "ReferenceFailedError",
      detail: expect.stringMatching(/no authors/),
    });
  });
});
