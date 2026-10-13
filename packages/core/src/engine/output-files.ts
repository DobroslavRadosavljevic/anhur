import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Predicate, Schema } from "effect";
import { messageOf } from "../diagnostics";
import { contentHash, type OutputFile, type PlanRevision } from "./codegen";
import {
  isSettled,
  mapPool,
  readSignature,
  sameSignature,
  type FileSignature,
} from "./file-signature";
import { GENERATED_HEADER } from "./serialize";

/** Name of the manifest that marks a folder as Anhur output. */
export const MANIFEST_FILE = ".anhur-manifest.json";
const MANIFEST_VERSION = 1;
const SAFE_PATH =
  /^(?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*$/;
const WRITE_CONCURRENCY = 16;
const VERIFY_CONCURRENCY = 32;
/** Name of the file `writeAtomic` makes next to its target. */
const TEMP_FILE = /^\..+\.[0-9a-f]{8}\.tmp$/;
/**
 * Paths the versions before the manifest (0.0.x) wrote: `.keep`, the
 * index, one module per list, getter and singleton, one module per
 * document in `documents/<source>/`, and the default index of
 * `@anhur/orama`.
 */
const LEGACY_FILE =
  /^(?:\.keep|index\.d\.ts|[A-Za-z_$][\w$]*\.js|documents\/[^/\\]+\/[^/\\]+\.js|search\/orama\.json)$/;

export type WriteResult = {
  /** Absolute paths written in this build. */
  readonly written: readonly string[];
  /** Absolute paths removed in this build. */
  readonly removed: readonly string[];
};

/** Files of an output folder with the hash of their text (`""`: unknown). */
export type OutputManifest = {
  readonly files: ReadonlyMap<string, string>;
};

/**
 * What a session knows about an output folder between builds, so a build
 * that changes one document does not read the manifest and look at every
 * generated file again.
 */
export type OutputState = {
  manifest: OutputManifest | undefined;
  manifestSignature: FileSignature | undefined;
  /**
   * mtime of every folder of the output after the last write. A folder
   * whose mtime is the same has the same entries: no file was deleted.
   */
  folders: Map<string, number>;
  /** Epoch milliseconds when `folders` was read. */
  foldersAt: number;
  /** The files on disk were compared with the manifest in this session. */
  verified: boolean;
  /** `OutputPlan.revision` of the plan written last. */
  revision: PlanRevision | undefined;
};

export function createOutputState(): OutputState {
  return {
    manifest: undefined,
    manifestSignature: undefined,
    folders: new Map(),
    foldersAt: 0,
    verified: false,
    revision: undefined,
  };
}

/** A problem with the output folder, reported as a build failure. */
export class OutputWriteError extends Schema.TaggedError<OutputWriteError>()(
  "OutputWriteError",
  {
    message: Schema.String,
    /** The file the problem is about, when it is about one file. */
    path: Schema.optional(Schema.String),
  },
) {}

function writeError(message: string, file?: string): OutputWriteError {
  return new OutputWriteError({ message, path: file });
}

function isSafeRelative(file: string): boolean {
  return SAFE_PATH.test(file) && !file.split("/").includes("..");
}

/** True for a file {@link writeOutputFiles} left behind when it was killed. */
export function isTempFile(name: string): boolean {
  return TEMP_FILE.test(name);
}

function isLegacyFile(file: string): boolean {
  return LEGACY_FILE.test(file) && !file.split("/").includes("..");
}

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder + path.sep);
}

function parseManifest(text: string): OutputManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !Predicate.isObject(raw) ||
    !("version" in raw) ||
    raw.version !== MANIFEST_VERSION ||
    !("files" in raw) ||
    !Predicate.isObject(raw.files)
  ) {
    return undefined;
  }
  const files = new Map<string, string>();
  for (const [file, hash] of Object.entries(raw.files)) {
    // Files of an older Anhur are listed until they are removed.
    if (
      Predicate.isString(hash) &&
      (isSafeRelative(file) || isLegacyFile(file))
    ) {
      files.set(file, hash);
    }
  }
  return { files };
}

/**
 * The manifest of `outputDir`, read again only when the file on disk is
 * not the one this session last read or wrote (another process may build
 * into the same folder).
 */
export async function currentManifest(
  outputDir: string,
  state: OutputState,
): Promise<OutputManifest | undefined> {
  const file = path.join(outputDir, MANIFEST_FILE);
  const signature = await readSignature(file);
  if (!signature) {
    state.manifest = undefined;
    state.manifestSignature = undefined;
    return undefined;
  }
  if (
    state.manifest &&
    state.manifestSignature &&
    sameSignature(signature, state.manifestSignature)
  ) {
    return state.manifest;
  }
  let manifest: OutputManifest | undefined;
  try {
    manifest = parseManifest(await readFile(file, "utf8"));
  } catch {
    manifest = undefined;
  }
  state.manifest = manifest;
  state.manifestSignature = manifest ? signature : undefined;
  // Another writer was here: look at the files again.
  state.verified = false;
  return manifest;
}

async function listFiles(outputDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(outputDir, { recursive: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const info = await readSignature(path.join(outputDir, entry));
    if (info?.isFile) files.push(entry.split(path.sep).join("/"));
  }
  return files;
}

/**
 * Files of a folder written by an older Anhur (no manifest yet), or
 * `undefined` when the folder is not such a folder: its `index.js` is not
 * generated, or it has a file with a name those versions never wrote (so
 * a file of the user is never taken for output).
 */
export async function adoptLegacy(
  outputDir: string,
): Promise<OutputManifest | undefined> {
  let index: string;
  try {
    index = await readFile(path.join(outputDir, "index.js"), "utf8");
  } catch {
    return undefined;
  }
  if (!index.startsWith("// generated by @anhur/core")) return undefined;
  const files = (await listFiles(outputDir)).filter(
    (file) => !isTempFile(path.posix.basename(file)),
  );
  if (!files.every(isLegacyFile)) return undefined;
  return { files: new Map(files.map((file) => [file, ""] as const)) };
}

/**
 * Write a file next to its target, then move it into place. The file next
 * to the target is removed when a step fails.
 */
async function writeAtomic(target: string, contents: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await writeFile(temporary, contents);
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * Real path of `folder`. For a folder that does not exist yet: the real
 * path of the closest parent that exists, plus the rest.
 */
async function realFolder(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch (cause) {
    const parent = path.dirname(folder);
    const missing =
      Predicate.isObject(cause) && "code" in cause && cause.code === "ENOENT";
    if (!missing || parent === folder) throw cause;
    return path.join(await realFolder(parent), path.basename(folder));
  }
}

async function removeEmptyParents(
  outputDir: string,
  file: string,
): Promise<void> {
  let dir = path.dirname(file);
  while (dir.startsWith(outputDir + path.sep)) {
    try {
      // Fails (and ends the walk) when the folder still has entries.
      await rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function sameFiles(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [file, hash] of left) {
    if (right.get(file) !== hash) return false;
  }
  return true;
}

/**
 * What the folders say about the files since the last write:
 * - `same`: no entry was added or removed;
 * - `recent`: the folders look the same, but were changed so shortly
 *   before they were looked at that a later change may not show in their
 *   mtime (see `isSettled`): the entries have to be listed;
 * - `changed`: an entry was added or removed, or nothing is known yet.
 */
async function folderState(
  state: OutputState,
): Promise<"same" | "recent" | "changed"> {
  if (state.folders.size === 0) return "changed";
  const now = await Promise.all(
    [...state.folders.keys()].map((folder) => readSignature(folder)),
  );
  let settled = true;
  let index = 0;
  for (const mtimeMs of state.folders.values()) {
    if (now[index]?.mtimeMs !== mtimeMs) return "changed";
    if (!isSettled(mtimeMs, state.foldersAt)) settled = false;
    index += 1;
  }
  return settled ? "same" : "recent";
}

/** Files and folders (POSIX paths below `outputDir`) that are on disk now. */
async function existingEntries(
  outputDir: string,
): Promise<ReadonlySet<string>> {
  try {
    const entries = await readdir(outputDir, { recursive: true });
    return new Set(entries.map((entry) => entry.split(path.sep).join("/")));
  } catch {
    return new Set();
  }
}

function rank(file: OutputFile): number {
  return file.path === "index.js" ? 2 : file.path === "index.d.ts" ? 1 : 0;
}

/**
 * Write changed files, delete stale ones and update the manifest.
 *
 * - Files are moved into place one by one (never half written);
 *   `index.d.ts` and `index.js` go last, after the modules they point at.
 * - The manifest lists a file before the file is made, and has the hash
 *   of a file only while the file on disk has that text: a file about to
 *   be written is listed with an unknown hash (`""`) first. So a build
 *   that fails or is killed leaves no file a later build would take for
 *   current, and none it would not clean up.
 * - Only files listed in the manifest, files of an older Anhur (see
 *   {@link adoptLegacy}) and temp files of this writer are deleted.
 * - Nothing is written or deleted through a symbolic link that leads out
 *   of the output folder.
 * - After `signal` is aborted no new file is started; the files in work
 *   are finished, the manifest is written, and the call rejects.
 *
 * Rejects with {@link OutputWriteError} for a problem with the folder. An
 * error thrown by `contents()` of a file is passed on as it is.
 */
export async function writeOutputFiles(
  outputDir: string,
  files: readonly OutputFile[],
  revision: PlanRevision,
  state: OutputState,
  now: number,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const manifest = await currentManifest(outputDir, state);
  const firstLook = !state.verified;
  const folders = firstLook ? "changed" : await folderState(state);
  // The plan written last, and nothing touched the folder since: done.
  if (manifest && state.revision === revision && folders === "same") {
    return { written: [], removed: [] };
  }
  state.revision = undefined;
  const previous = manifest ?? (await adoptLegacy(outputDir));
  const previousFiles = previous?.files ?? new Map<string, string>();
  const next = new Map<string, string>();
  for (const file of files) {
    // Paths of the manifest were checked when it was read or written.
    if (
      !previousFiles.has(file.path) &&
      (!isSafeRelative(file.path) || file.path === MANIFEST_FILE)
    ) {
      throw writeError(
        `Refusing to write the unsafe output path "${file.path}".`,
        file.path,
      );
    }
    next.set(file.path, file.hash);
  }
  const targetOf = (file: string) => path.join(outputDir, ...file.split("/"));
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const writeManifest = async (entries: ReadonlyMap<string, string>) => {
    try {
      await mkdir(outputDir, { recursive: true });
      await writeAtomic(
        manifestPath,
        `${JSON.stringify(
          {
            version: MANIFEST_VERSION,
            generator: GENERATED_HEADER,
            files: Object.fromEntries(
              [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
            ),
          },
          null,
          2,
        )}\n`,
      );
    } catch (cause) {
      throw writeError(
        `Could not write the output manifest: ${messageOf(cause)}`,
        manifestPath,
      );
    }
    state.manifest = { files: new Map(entries) };
    state.manifestSignature = await readSignature(manifestPath);
  };

  // A planned file with the hash the manifest has is kept when it is still
  // on disk as it was written. The first build of a session reads every
  // such file and compares its content (a hand edit can keep the size).
  // Later builds look at the size, and only when a folder lost or gained an
  // entry; when the folders only changed a moment ago, their entries are
  // listed instead. The first look of a session lists them too, to find
  // temp files.
  const onDisk =
    firstLook || folders === "recent"
      ? await existingEntries(outputDir)
      : undefined;
  const pending: OutputFile[] = [];
  const kept: OutputFile[] = [];
  for (const file of files) {
    if (previousFiles.get(file.path) === file.hash) kept.push(file);
    else pending.push(file);
  }
  if (folders === "recent") {
    for (const file of kept) {
      if (!onDisk?.has(file.path)) pending.push(file);
    }
  } else if (folders === "changed") {
    const intact = await mapPool(kept, VERIFY_CONCURRENCY, async (file) => {
      const target = targetOf(file.path);
      const info = await readSignature(target);
      if (info === undefined || !info.isFile || info.size !== file.size) {
        return false;
      }
      // The first build of a session reads every file: an edit that kept
      // the size (a date, a digit) shows only in the content. Later builds
      // of the session trust the size.
      if (!firstLook) return true;
      try {
        return contentHash(await readFile(target)) === file.hash;
      } catch {
        return false;
      }
    });
    for (const [index, file] of kept.entries()) {
      if (!intact[index]) pending.push(file);
    }
  }
  const stale = [...previousFiles.keys()].filter((file) => !next.has(file));
  // Left by a build that was killed between writing a file and moving it
  // into place.
  const temps = [...(onDisk ?? [])].filter((entry) =>
    isTempFile(path.posix.basename(entry)),
  );

  // A symbolic link in the output folder can lead to a folder of the
  // user: nothing is written or deleted behind it.
  const realFolders = new Map<string, Promise<string>>();
  const realOf = (folder: string): Promise<string> => {
    let real = realFolders.get(folder);
    if (!real) {
      real = realFolder(folder);
      realFolders.set(folder, real);
    }
    return real;
  };
  const insideOutput = async (folder: string): Promise<boolean> => {
    const [root, real] = await Promise.all([realOf(outputDir), realOf(folder)]);
    return isInside(real, root);
  };
  /** Reject when the folder of one of `paths` is outside the output folder. */
  const guard = async (action: string, paths: readonly string[]) => {
    const checked = new Set<string>();
    for (const file of paths) {
      const target = targetOf(file);
      const folder = path.dirname(target);
      if (checked.has(folder)) continue;
      checked.add(folder);
      let inside: boolean;
      try {
        inside = await insideOutput(folder);
      } catch (cause) {
        throw writeError(
          `Could not look at the folder ${folder}: ${messageOf(cause)}`,
          target,
        );
      }
      if (!inside) {
        throw writeError(
          `Refusing to ${action} ${target}: a symbolic link leads from the output folder ${outputDir} to another folder.`,
          target,
        );
      }
    }
  };
  await guard(
    "write",
    pending.map((file) => file.path),
  );
  await guard("delete", stale);
  await Promise.all(
    temps.map(async (entry) => {
      const target = targetOf(entry);
      const inside = await insideOutput(path.dirname(target)).catch(
        () => false,
      );
      if (inside) await rm(target, { force: true }).catch(() => undefined);
    }),
  );

  // What the manifest says. A file about to be written is listed first,
  // with an unknown hash: its text on disk is not known until it is moved
  // into place.
  const recorded = new Map(previousFiles);
  for (const file of pending) recorded.set(file.path, "");
  const saveManifest = async () => {
    if (!state.manifest || !sameFiles(recorded, state.manifest.files)) {
      await writeManifest(recorded);
    }
  };
  if (pending.length > 0) await saveManifest();

  const removed: string[] = [];
  const removeStale = async (file: string): Promise<void> => {
    const target = targetOf(file);
    try {
      await rm(target, { force: true });
    } catch {
      // Still listed, so a later build tries again.
      recorded.set(file, "");
      return;
    }
    recorded.delete(file);
    removed.push(target);
    await removeEmptyParents(outputDir, target);
  };
  const writeFileAt = async (file: OutputFile): Promise<void> => {
    const target = targetOf(file.path);
    // Not caught: an error here is a bug of the code that planned the file.
    const contents = file.contents();
    try {
      await writeAtomic(target, contents);
    } catch (cause) {
      throw writeError(
        `Could not write ${target}: ${messageOf(cause)}`,
        target,
      );
    }
    recorded.set(file.path, file.hash);
  };
  const ordered = [...pending].sort((a, b) => rank(a) - rank(b));

  try {
    // A case-only rename (getBlogPost.js → getBlogpost.js) is one file on
    // case-insensitive file systems: remove the old name before writing
    // the new one, never after.
    const renamed = new Set<string>();
    let nextInLowerCase: Set<string> | undefined;
    for (const file of stale) {
      nextInLowerCase ??= new Set(
        [...next.keys()].map((name) => name.toLowerCase()),
      );
      if (!nextInLowerCase.has(file.toLowerCase())) continue;
      renamed.add(file);
      await removeStale(file);
    }
    if (ordered.length > 0) {
      const parents = new Set(
        ordered.map((file) => path.dirname(targetOf(file.path))),
      );
      try {
        await Promise.all(
          [...parents].map((folder) => mkdir(folder, { recursive: true })),
        );
      } catch (cause) {
        throw writeError(
          `Could not create the output folders: ${messageOf(cause)}`,
        );
      }
      await mapPool(
        ordered.filter((file) => rank(file) === 0),
        WRITE_CONCURRENCY,
        async (file) => {
          if (!signal?.aborted) await writeFileAt(file);
        },
      );
      for (const file of ordered) {
        if (rank(file) !== 0 && !signal?.aborted) await writeFileAt(file);
      }
    }
    if (signal?.aborted) throw writeError("Writing the output was stopped.");
    for (const file of stale) {
      if (!renamed.has(file)) await removeStale(file);
    }
    await saveManifest();
  } catch (cause) {
    // The manifest on disk says which files were written. When it cannot
    // be written either, the one from before the writes is still true.
    await saveManifest().catch(() => undefined);
    throw cause;
  }

  const watched = new Set<string>([outputDir]);
  const subfolders = new Set<string>();
  for (const file of next.keys()) {
    const slash = file.lastIndexOf("/");
    if (slash !== -1) subfolders.add(file.slice(0, slash));
  }
  for (const subfolder of subfolders) watched.add(targetOf(subfolder));
  state.folders = new Map();
  state.foldersAt = now;
  await Promise.all(
    [...watched].map(async (folder) => {
      const info = await stat(folder).catch(() => undefined);
      if (info) state.folders.set(folder, info.mtimeMs);
    }),
  );
  state.verified = true;
  state.revision = revision;
  return {
    written: ordered.map((file) => targetOf(file.path)),
    removed,
  };
}
