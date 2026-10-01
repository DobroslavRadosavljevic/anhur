import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Manifest `@anhur/assets` keeps in its assets folder: the files the last
 * build uses (`{ "files": [...] }`). Read by name so this package does not
 * depend on `@anhur/assets` at runtime.
 */
const ASSETS_MANIFEST = ".anhur-assets.json";

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFileList(value: unknown): value is { readonly files: string[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    "files" in value &&
    Array.isArray(value.files) &&
    value.files.every(isString)
  );
}

/** A plain file name: no folders, no dotfiles. */
function isPlainName(name: string): boolean {
  return (
    name !== "" &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Files of the current build in `dir`: the manifest when there is one
 * (so files of older builds that were not pruned yet never ship), else
 * every plain file. `undefined` when the folder does not exist.
 */
async function currentFiles(dir: string): Promise<string[] | undefined> {
  let raw: string | undefined;
  try {
    raw = await readFile(path.join(dir, ASSETS_MANIFEST), "utf8");
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
  if (raw !== undefined) {
    const parsed: unknown = JSON.parse(raw);
    if (!isFileList(parsed)) {
      throw new Error(`[anhur] ${path.join(dir, ASSETS_MANIFEST)} is damaged.`);
    }
    return parsed.files.filter(isPlainName);
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isPlainName(entry.name))
      .map((entry) => entry.name);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

/**
 * Copy the current build's assets from `dir` into the app output under
 * `localBase` (URL-encoded, `/` for the output root). Fails for a base
 * that points outside the output folder. Returns the number of files.
 */
export async function copyAssetsToOutput(
  dir: string,
  localBase: string,
  outDir: string,
): Promise<number> {
  let segment: string;
  try {
    segment = decodeURIComponent(localBase).replace(/^\/+|\/+$/g, "");
  } catch (cause) {
    throw new Error(`[anhur] the assets base "${localBase}" is not valid.`, {
      cause,
    });
  }
  const root = path.resolve(outDir);
  const target = path.resolve(root, segment);
  if (!isInside(target, root)) {
    throw new Error(
      `[anhur] the assets base "${localBase}" points outside the build output (${root}).`,
    );
  }
  const files = await currentFiles(dir);
  if (!files || files.length === 0) return 0;
  await mkdir(target, { recursive: true });
  for (const file of files) {
    await copyFile(path.join(dir, file), path.join(target, file));
  }
  return files.length;
}
