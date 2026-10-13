import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileGlob,
  GlobPatternError,
  globProblem,
  globSource,
  listContentFiles,
} from "../../src/engine/content-files";
import { createProject, type TestProject } from "../fixtures/temp-project";

// Failure modes these tests are for:
// 1. A pattern gives another result on Bun than on Node (groups, `{a}`,
//    `./`, `//`, `..`, `\`), or a class range matches `/`.
// 2. A pattern the matcher does not handle matches nothing, without a word.
// 3. Several `**` in a row make the expression slow.
// 4. `exclude: ["drafts/"]` excludes nothing.
// 5. A name typed composed (NFC) does not match the same name stored
//    decomposed (NFD).
// 6. A link back to the content folder is entered again and again.
// 7. The walker leaves out a folder that a pattern can match.

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

/** False where the platform or the user may not make symbolic links. */
function canLink(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "anhur-link-"));
  try {
    mkdirSync(path.join(dir, "target"));
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function list(
  root: string,
  include: readonly string[],
  exclude: readonly string[] = [],
): Promise<string[]> {
  const files = await listContentFiles(root, { include, exclude, skip: [] });
  return files.map((file) => file.relative);
}

describe("compileGlob", () => {
  const paths = [
    "a.md",
    "b.md",
    "ab.md",
    "aab.md",
    "a.mdx",
    "c.json",
    "x1.md",
    "{a}.md",
    "a(b).md",
    "a+b.md",
    "a b.md",
    "posts/a.md",
    "posts/b.mdx",
    "posts/2024/a.md",
    "drafts/a.md",
    "a/b",
  ];
  // What Node 22 answers (`path.matchesGlob`; `fs.glob` for `./`). Bun's
  // `path.matchesGlob` answers 12 of these in another way.
  const expected: readonly (readonly [string, readonly string[]])[] = [
    ["{a}.md", ["{a}.md"]],
    ["{a,b}{.md,.mdx}", ["a.md", "b.md", "a.mdx"]],
    ["x{1,2}.md", ["x1.md"]],
    ["+(a|b).md", ["a.md", "b.md", "ab.md", "aab.md"]],
    ["@(a|b).md", ["a.md", "b.md"]],
    ["?(a)b.md", ["b.md", "ab.md"]],
    ["*(a)b.md", ["b.md", "ab.md", "aab.md"]],
    ["a@(.md|.mdx)", ["a.md", "a.mdx"]],
    ["a(b).md", ["a(b).md"]],
    ["a+b.md", ["a+b.md"]],
    ["a**.md", ["a.md", "ab.md", "aab.md", "a(b).md", "a+b.md", "a b.md"]],
    ["a**/b", ["a/b"]],
    ["**/**/a.md", ["a.md", "posts/a.md", "posts/2024/a.md", "drafts/a.md"]],
    ["[!a].md", ["b.md"]],
    ["[]a].md", ["a.md"]],
    ["[a", []],
    ["./posts/*.md", ["posts/a.md"]],
    ["posts/./a.md", ["posts/a.md"]],
    ["posts//a.md", ["posts/a.md"]],
    ["posts/../a.md", ["a.md"]],
    ["posts/2024/../*.md", ["posts/a.md"]],
    ["posts\\*.md", ["posts/a.md"]],
    ["{posts,drafts}/*.md", ["posts/a.md", "drafts/a.md"]],
    ["{posts/2024,drafts}/a.md", ["posts/2024/a.md", "drafts/a.md"]],
    // A pattern for a folder matches no file.
    ["posts/", []],
    ["posts/.", []],
    // A range that has `/` between its ends does not match `/`.
    ["a[.-z]b", []],
    ["${a,b}.md", []],
  ];

  it("gives the same answer on every runtime for patterns the runtimes read differently", () => {
    for (const [pattern, matching] of expected) {
      expect(paths.filter(compileGlob(pattern)), pattern).toEqual(matching);
    }
  });

  it("refuses a pattern it does not match, with the reason", () => {
    const problems: readonly (readonly [string, string])[] = [
      ["", "empty"],
      ["./", "content folder itself"],
      ["!drafts/**", "negation"],
      ["!(a).md", '"!(...)"'],
      ["../shared/*.md", '".."'],
      ["posts/../../a.md", '".."'],
      ["**/../a.md", '".." after "**"'],
      ["/srv/content/*.md", "absolute"],
      ["C:\\content\\*.md", "absolute"],
      ["post-{1..3}.md", "{1..3}"],
      ["[[:alpha:]]*.md", "POSIX"],
      ["[z-a].md", "backwards"],
      ["+(a|b.md", 'no ")"'],
    ];
    for (const [pattern, word] of problems) {
      expect(globProblem(pattern), pattern).toContain(word);
      expect(() => compileGlob(pattern), pattern).toThrow(GlobPatternError);
    }
    for (const pattern of ["**/*.md", "+(a|b)/*.md", "{a}.md", "drafts/"]) {
      expect(globProblem(pattern), pattern).toBe(undefined);
    }
  });

  it("reads several ** in a row as one", () => {
    expect(globSource("**/**/a")).toBe(globSource("**/a"));
    expect(globSource("posts/**/**/**/*.mdx")).toBe(
      globSource("posts/**/*.mdx"),
    );
  });
});

describe("listContentFiles", () => {
  it("leaves out a folder named by an exclude pattern that ends with /", async () => {
    const project = await createProject({
      "content/a.md": "",
      "content/drafts/x.md": "",
      "content/posts/k.md": "",
      "content/posts/2024/y.md": "",
      "content/posts/drafts/z.md": "",
      // A file, not a folder: `drafts/` does not name it.
      "content/notes/drafts": "",
    });
    projects.push(project);
    const root = project.path("content");
    expect(await list(root, ["**/*.md"], ["drafts/"])).toEqual([
      "a.md",
      "posts/2024/y.md",
      "posts/drafts/z.md",
      "posts/k.md",
    ]);
    expect(await list(root, ["**/*.md"], ["posts/2024/"])).toEqual([
      "a.md",
      "drafts/x.md",
      "posts/drafts/z.md",
      "posts/k.md",
    ]);
    expect(await list(root, ["**"], ["**/drafts/"])).toEqual([
      "a.md",
      "notes/drafts",
      "posts/2024/y.md",
      "posts/k.md",
    ]);
    // In include, a pattern for a folder lists no file (as with fs.glob).
    expect(await list(root, ["posts/"])).toEqual([]);
  });

  it("matches a name stored decomposed (NFD) with a pattern typed composed (NFC), and the other way round", async () => {
    const composed = {
      resume: "r\u00e9sum\u00e9",
      uber: "\u00fcber",
      cafe: "caf\u00e9",
    };
    const decomposed = {
      resume: "re\u0301sume\u0301",
      uber: "u\u0308ber",
      cafe: "cafe\u0301",
    };
    const project = await createProject({
      [`content/${decomposed.resume}/cv.md`]: "",
      [`content/${decomposed.uber}.md`]: "",
      [`content/${composed.cafe}/menu.md`]: "",
      "content/plain.md": "",
    });
    projects.push(project);
    const root = project.path("content");
    const nfc = async (include: string[], exclude: string[] = []) =>
      (await list(root, include, exclude)).map((file) => file.normalize("NFC"));
    expect(await nfc([`${composed.resume}/*.md`])).toEqual([
      `${composed.resume}/cv.md`,
    ]);
    expect(await nfc([`${composed.uber}.md`])).toEqual([`${composed.uber}.md`]);
    expect(await nfc([`${decomposed.cafe}/*.md`])).toEqual([
      `${composed.cafe}/menu.md`,
    ]);
    expect(await nfc(["**/*.md"], [`${composed.resume}/**`])).toEqual([
      `${composed.cafe}/menu.md`,
      "plain.md",
      `${composed.uber}.md`,
    ]);
  });

  it.skipIf(!canLink())(
    "does not enter a link to the content folder or to a folder it is in",
    async () => {
      const project = await createProject({
        "content/a.md": "",
        "content/posts/p.md": "",
        "shared/guide.md": "",
        "other/x.md": "",
      });
      projects.push(project);
      const root = project.path("content");
      await symlink(root, path.join(root, "posts", "loop"));
      await symlink(project.path("shared"), path.join(root, "guides"));
      await symlink(root, project.path("shared/back"));
      await symlink(project.path("shared"), project.path("shared/again"));
      await symlink(project.path("other"), project.path("shared/more"));
      // A link to a folder that is not on the way is entered, link after link.
      expect(await list(root, ["guides/*.md"])).toEqual(["guides/guide.md"]);
      expect(await list(root, ["guides/more/*.md"])).toEqual([
        "guides/more/x.md",
      ]);
      // Links to the root, and to the folder the walk is in, are not.
      expect(await list(root, ["posts/loop/*.md"])).toEqual([]);
      expect(await list(root, ["posts/loop/posts/loop/posts/*.md"])).toEqual(
        [],
      );
      expect(await list(root, ["guides/back/*.md"])).toEqual([]);
      expect(await list(root, ["guides/again/*.md"])).toEqual([]);
      // Wildcards never go through a link, so every file is listed once.
      expect(await list(root, ["**/*.md", "*/*/*.md", "*/*/*/*.md"])).toEqual([
        "a.md",
        "posts/p.md",
      ]);
    },
  );

  it("lists the same files as a walk of the whole tree with the matcher", async () => {
    const project = await createProject({
      "content/a.md": "",
      "content/b.mdx": "",
      "content/c.json": "",
      "content/posts/a.md": "",
      "content/posts/b.mdx": "",
      "content/posts/2024/a.md": "",
      "content/posts/2024/deep/x.md": "",
      "content/posts/2025/a.md": "",
      "content/posts/drafts/a.md": "",
      "content/drafts/a.md": "",
      "content/drafts/2024/b.md": "",
      "content/pages/deep/2024/c.md": "",
      "content/x.md/y.md": "",
    });
    projects.push(project);
    const root = project.path("content");
    const all = await list(root, ["**"]);
    expect(all).toHaveLength(13);
    const patterns = [
      "*.md",
      "posts/*.md",
      "posts/**/*.md",
      "posts/**",
      "*/*.md",
      "*/*/*.md",
      "**/2024/*.md",
      "**/2024/**",
      "posts/*/*/*.md",
      "{posts,drafts}/**/*.md",
      "**/deep/**",
      "p*/20?4/**",
      "+(posts|drafts)/*.md",
      "**/*.{md,mdx}",
      "posts/2024/deep/x.md",
      "pages/../posts/*.md",
      "**/y.md",
      "x.md/*.md",
      "**/posts/**/a.md",
    ];
    for (const pattern of patterns) {
      expect(await list(root, [pattern]), pattern).toEqual(
        all.filter(compileGlob(pattern)),
      );
    }
    // Several patterns at once: a folder is read for each that can match.
    expect(
      await list(root, ["posts/2024/*.md", "**/*.json", "*/*.mdx"]),
    ).toEqual(["c.json", "posts/2024/a.md", "posts/b.mdx"]);
  });
});
