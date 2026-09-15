import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  canonicalizePath,
  collectWatchPaths,
  defineCollection,
  defineConfig,
  defineSingleton,
  isAnhurWatchTarget,
  isUnderWatchPath,
} from "../../src/index";

const schema = z.object({ title: z.string() });

describe("collectWatchPaths", () => {
  it("includes config and collection directories", () => {
    const root = path.resolve("/tmp/anhur-watch-paths-proj");
    const config = defineConfig({
      content: [
        defineCollection({
          name: "posts",
          directory: "content/posts",
          include: "**/*.md",
          schema,
        }),
      ],
    });

    const paths = collectWatchPaths(
      config,
      root,
      path.join(root, "anhur.config.ts"),
    );

    expect(paths).toContain(
      canonicalizePath(path.join(root, "anhur.config.ts")),
    );
    expect(paths).toContain(canonicalizePath(path.join(root, "content/posts")));
    expect(paths).toContain(canonicalizePath(path.join(root, "cms")));
  });

  it("watches parent dirs of emitAsset sources outside content roots", () => {
    const root = path.resolve("/tmp/anhur-watch-paths-proj");
    const config = defineConfig({
      content: [
        defineCollection({
          name: "posts",
          directory: "content/posts",
          include: "**/*.md",
          schema,
        }),
      ],
    });

    const sharedLogo = path.join(root, "shared", "logo.png");
    const paths = collectWatchPaths(
      config,
      root,
      path.join(root, "anhur.config.ts"),
      [sharedLogo],
    );

    expect(paths).toContain(canonicalizePath(path.join(root, "shared")));
    expect(paths).not.toContain(canonicalizePath(sharedLogo));
  });

  it("does not add extra roots for assets already under a content directory", () => {
    const root = path.resolve("/tmp/anhur-watch-paths-proj");
    const config = defineConfig({
      content: [
        defineCollection({
          name: "posts",
          directory: "content/posts",
          include: "**/*.md",
          schema,
        }),
      ],
    });

    const nested = path.join(root, "content/posts/cover.png");
    const paths = collectWatchPaths(
      config,
      root,
      path.join(root, "anhur.config.ts"),
      [nested],
    );

    expect(
      paths.filter((p) => p.endsWith(`${path.sep}content${path.sep}posts`)),
    ).toHaveLength(1);
  });

  it("includes singleton file paths", () => {
    const root = path.resolve("/tmp/anhur-watch-paths-proj");
    const config = defineConfig({
      content: [
        defineSingleton({
          name: "site",
          filePath: "content/site.yaml",
          schema,
        }),
      ],
    });

    const paths = collectWatchPaths(
      config,
      root,
      path.join(root, "anhur.config.ts"),
    );

    expect(paths).toContain(
      canonicalizePath(path.join(root, "content/site.yaml")),
    );
  });
});

describe("isAnhurWatchTarget", () => {
  it("matches files inside watched directories", () => {
    const posts = canonicalizePath(
      path.resolve("/tmp/anhur-watch-paths-proj/content/posts"),
    );
    expect(
      isUnderWatchPath(
        path.resolve("/tmp/anhur-watch-paths-proj/content/posts/hello.md"),
        posts,
      ),
    ).toBe(true);
    expect(
      isAnhurWatchTarget(
        path.resolve("/tmp/anhur-watch-paths-proj/content/posts/hello.md"),
        [posts],
      ),
    ).toBe(true);
  });

  it("matches the config file itself", () => {
    const cfg = canonicalizePath(
      path.resolve("/tmp/anhur-watch-paths-proj/anhur.config.ts"),
    );
    expect(
      isAnhurWatchTarget(
        path.resolve("/tmp/anhur-watch-paths-proj/anhur.config.ts"),
        [cfg],
      ),
    ).toBe(true);
  });

  it("ignores unrelated paths", () => {
    const posts = canonicalizePath(
      path.resolve("/tmp/anhur-watch-paths-proj/content/posts"),
    );
    expect(
      isAnhurWatchTarget(
        path.resolve("/tmp/anhur-watch-paths-proj/README.md"),
        [posts],
      ),
    ).toBe(false);
    expect(
      isAnhurWatchTarget(
        path.resolve("/tmp/anhur-watch-paths-proj/content/pages/x.md"),
        [posts],
      ),
    ).toBe(false);
  });
});
