import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishStagingDirectory,
  stagingDirectoryFor,
} from "../../src/publish-dir";

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("publishStagingDirectory", () => {
  it("replaces live contents with staging and removes the staging path", async () => {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "publish-"));
    scratchRoots.push(root);

    const live = path.join(root, "generated");
    const staging = stagingDirectoryFor(live);
    await mkdir(live, { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(live, "old.txt"), "old");
    await writeFile(path.join(staging, "new.txt"), "new");

    await publishStagingDirectory(staging, live);

    expect(await readFile(path.join(live, "new.txt"), "utf8")).toBe("new");
    await expect(
      readFile(path.join(live, "old.txt"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(staging, "new.txt"), "utf8"),
    ).rejects.toThrow();
  });
});
