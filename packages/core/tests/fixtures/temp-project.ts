import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root; temp projects live in `<package>/.tmp` so `@anhur/core` resolves by self-reference. */
export const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export type TestProject = {
  readonly dir: string;
  readonly path: (file: string) => string;
  readonly write: (
    file: string,
    contents: string | Uint8Array,
  ) => Promise<void>;
  readonly read: (file: string) => Promise<string>;
  readonly remove: () => Promise<void>;
};

/** Create a project folder with the given files (paths relative to the project). */
export async function createProject(files: {
  readonly [file: string]: string | Uint8Array;
}): Promise<TestProject> {
  const dir = path.join(PACKAGE_DIR, ".tmp", randomUUID().slice(0, 8));
  const project: TestProject = {
    dir,
    path: (file) => path.join(dir, file),
    write: async (file, contents) => {
      const target = path.join(dir, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    },
    read: (file) => readFile(path.join(dir, file), "utf8"),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
  for (const [file, contents] of Object.entries(files)) {
    await project.write(file, contents);
  }
  return project;
}

/** 1×1 PNG. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
