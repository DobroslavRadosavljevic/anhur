import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "../../src/index";

const fixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

describe("hooks + drafts", () => {
  it("skips drafts, honors ctx.skip, runs prepare/onSuccess/complete", async () => {
    delete (globalThis as { __anhurOnSuccess?: number }).__anhurOnSuccess;
    delete (globalThis as { __anhurComplete?: number }).__anhurComplete;

    const result = await build({
      rootDir: path.join(fixturesRoot, "hooks-drafts"),
    });

    const posts = result.built.find((b) => b.source.name === "posts");
    expect(posts).toBeDefined();
    expect(posts!.documents).toHaveLength(1);
    const doc = posts!.documents[0]!;
    expect(doc.data.slug).toBe("published");
    expect(doc.data.tagged).toBe(true);
    expect(doc.data.prepared).toBe(true);
    expect((globalThis as { __anhurOnSuccess?: number }).__anhurOnSuccess).toBe(
      1,
    );
    expect((globalThis as { __anhurComplete?: number }).__anhurComplete).toBe(
      1,
    );
  });
});
