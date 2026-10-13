import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listContentFiles } from "../../src/engine/content-files";
import { createProject, type TestProject } from "../fixtures/temp-project";

// Failure modes these tests are for:
// 1. The walker reads every folder of the tree, also when the patterns can
//    only match in a few of them (it runs on every rebuild).
// 2. A folder that cannot be listed for a reason other than "gone" or "no
//    permission" (too many open files, a disk error) is left out without a
//    word: its documents vanish and their generated modules are removed.
// 3. A listing whose build was stopped goes on reading the whole tree.

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

/**
 * A reader of folders that notes each folder it is asked for, and rejects
 * with the error code given for a folder in `failures`.
 */
function notingReader(failures: ReadonlyMap<string, string> = new Map()) {
  const folders: string[] = [];
  const readFolder = (folder: string) => {
    folders.push(folder);
    const code = failures.get(folder);
    return code === undefined
      ? readdir(folder, { withFileTypes: true })
      : Promise.reject(
          Object.assign(new Error(`${code}: scandir '${folder}'`), { code }),
        );
  };
  return { folders, readFolder };
}

async function contentTree(): Promise<string> {
  const project = await createProject({
    "content/a.md": "",
    "content/posts/b.md": "",
    "content/posts/2024/c.md": "",
    "content/posts/2024/deep/d.md": "",
    "content/drafts/e.md": "",
    "content/drafts/old/f.md": "",
    "content/pages/g.md": "",
  });
  projects.push(project);
  return project.path("content");
}

/** The folders below `root` a listing reads, sorted. */
async function foldersRead(
  root: string,
  include: readonly string[],
  exclude: readonly string[] = [],
): Promise<string[]> {
  const { folders, readFolder } = notingReader();
  await listContentFiles(root, { include, exclude, skip: [], readFolder });
  return folders
    .map((folder) => path.relative(root, folder).split(path.sep).join("/"))
    .sort();
}

describe("listContentFiles", () => {
  it("reads only the folders that can hold a match", async () => {
    const root = await contentTree();
    expect(await foldersRead(root, ["*.md"])).toEqual([""]);
    expect(await foldersRead(root, ["posts/*.md"])).toEqual(["", "posts"]);
    expect(await foldersRead(root, ["posts/2024/*.md"])).toEqual([
      "",
      "posts",
      "posts/2024",
    ]);
    expect(await foldersRead(root, ["*/*.md"])).toEqual([
      "",
      "drafts",
      "pages",
      "posts",
    ]);
    expect(await foldersRead(root, ["p*/**/*.md", "a.md"])).toEqual([
      "",
      "pages",
      "posts",
      "posts/2024",
      "posts/2024/deep",
    ]);
    // An excluded folder is not read, also when the pattern names what is below it.
    expect(
      await foldersRead(root, ["**/*.md"], ["drafts/**", "posts/2024/"]),
    ).toEqual(["", "pages", "posts"]);
  });

  it("rejects when a folder cannot be listed for a reason other than gone or no permission", async () => {
    const root = await contentTree();
    for (const code of ["EMFILE", "EIO"]) {
      const { readFolder } = notingReader(
        new Map([[path.join(root, "posts", "2024"), code]]),
      );
      await expect(
        listContentFiles(root, {
          include: ["**/*.md"],
          exclude: [],
          skip: [],
          readFolder,
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("leaves out a folder that is gone without a report, and reports one it may not read", async () => {
    const root = await contentTree();
    const { readFolder } = notingReader(
      new Map([
        [path.join(root, "drafts"), "ENOENT"],
        [path.join(root, "posts", "2024"), "EACCES"],
      ]),
    );
    const skipped: string[] = [];
    const files = await listContentFiles(root, {
      include: ["**/*.md"],
      exclude: [],
      skip: [],
      readFolder,
      onSkip: (folder, reason) => void skipped.push(`${folder}: ${reason}`),
    });
    expect(files.map((file) => file.relative)).toEqual([
      "a.md",
      "pages/g.md",
      "posts/b.md",
    ]);
    expect(skipped).toEqual([
      `${path.join(root, "posts", "2024")}: no permission to read the folder`,
    ]);
  });

  it("reads no more folders after its signal is aborted, and rejects", async () => {
    const root = await contentTree();
    const controller = new AbortController();
    const { folders, readFolder } = notingReader();
    const listing = listContentFiles(root, {
      include: ["**/*.md"],
      exclude: [],
      skip: [],
      signal: controller.signal,
      readFolder: async (folder) => {
        const entries = await readFolder(folder);
        controller.abort();
        return entries;
      },
    });
    await expect(listing).rejects.toMatchObject({ name: "AbortError" });
    expect(folders).toEqual([root]);
  });
});
