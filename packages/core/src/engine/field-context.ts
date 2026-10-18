import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FieldPath } from "../document";
import { contentTypeForPath } from "../mime";
import {
  assetFileName,
  classifyUrl,
  hasDotSegment,
  isDocumentLinkPath,
} from "../plugin/links";
import type {
  AssetRef,
  FieldContext,
  LinkRole,
  ResolvedLink,
} from "../plugin/types";
import { rememberSignature, type SignatureMemo } from "./file-signature";
import { isInside, relativeTo } from "./paths";
import type { ResolvedProject } from "./resolve";
import type { SourceFile } from "./types";

/**
 * Hash of a source file, reused while its size, inode, mtime and ctime and
 * the host's transform version stay the same.
 */
export type AssetHashEntry = {
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly version: string | undefined;
  readonly hash: string;
};

/** Effects collected for one document while its fields compile. */
export type EffectRecorder = {
  readonly assets: Map<string, AssetRef>;
  readonly dependencies: Set<string>;
  readonly warnings: string[];
};

/** Session-wide state shared by every field context of a build. */
export type FieldSession = {
  readonly project: ResolvedProject;
  /** Public asset URL prefix (`undefined` without an asset plugin). */
  readonly publicBase: string | undefined;
  /**
   * Allowed asset roots (absolute). They are resolved to native real paths
   * before use, so their case matches the paths of the files on
   * case-insensitive file systems.
   */
  readonly assetRoots: readonly string[];
  readonly hashes: Map<string, AssetHashEntry>;
  /** Stats taken in this build: every path is looked at once. */
  readonly stats: SignatureMemo;
  /**
   * Assets checked in this build, by the path a field gave. Documents that
   * share a file (a logo, an author photo) check and hash it once.
   */
  readonly emitted: Map<string, Promise<AssetRef>>;
};

export function createEffectRecorder(): EffectRecorder {
  return { assets: new Map(), dependencies: new Set(), warnings: [] };
}

/** Add what `from` recorded to `into`. */
export function mergeEffects(from: EffectRecorder, into: EffectRecorder): void {
  for (const [key, asset] of from.assets) into.assets.set(key, asset);
  for (const dependency of from.dependencies) into.dependencies.add(dependency);
  into.warnings.push(...from.warnings);
}

/** A value shared between the fields of a document, and what computing it reported. */
type SharedValue = {
  readonly value: Promise<unknown>;
  readonly effects: EffectRecorder;
};

/** Values the fields of one document share while it is compiled. */
export type DocumentShares = {
  /** Keys fields announced (`CompileFieldSpec.shares`). */
  readonly announced: Set<string>;
  readonly values: Map<string, SharedValue>;
};

export function createDocumentShares(): DocumentShares {
  return { announced: new Set(), values: new Map() };
}

/** SHA-256 (hex) of `prefix` followed by the bytes of `file`, streamed. */
function hashStream(file: string, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256").update(prefix);
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex"));
      });
  });
}

type FileInfo = {
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
};

/**
 * Asset hash: 16 hex chars of the SHA-256 of `${version}\0` + the file
 * bytes (just the bytes without a version). See `AssetHost.transformVersion`.
 */
async function hashFile(
  session: FieldSession,
  realPath: string,
  info: FileInfo,
  version: string | undefined,
): Promise<string> {
  const known = session.hashes.get(realPath);
  if (
    known &&
    known.size === info.size &&
    known.ino === info.ino &&
    known.mtimeMs === info.mtimeMs &&
    known.ctimeMs === info.ctimeMs &&
    known.version === version
  ) {
    return known.hash;
  }
  const prefix = version === undefined ? "" : `${version}\0`;
  const hash = (await hashStream(realPath, prefix)).slice(0, 16);
  session.hashes.set(realPath, {
    size: info.size,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    version,
    hash,
  });
  return hash;
}

/** The most specific allowed root that contains `real`. */
function matchingRoot(session: FieldSession, real: string): string | undefined {
  let best: string | undefined;
  for (const root of session.assetRoots) {
    if (!isInside(real, root)) continue;
    if (best === undefined || root.length > best.length) best = root;
  }
  return best;
}

function hasNodeModulesSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).includes("node_modules");
}

/**
 * Why the file at the real path `real` may not be an asset, by its path
 * alone (no file is read); `undefined` when the path rules allow it.
 * `shown` names the file in the message.
 */
function assetPathProblem(
  session: FieldSession,
  real: string,
  shown: string,
): string | undefined {
  const host = session.project.assetHost;
  if (!host || session.publicBase === undefined) {
    return `"${shown}" is a local file, but no plugin handles assets. Add assets() from @anhur/assets to defineConfig({ plugins }).`;
  }
  const root = matchingRoot(session, real);
  if (!root) {
    return `"${shown}" is outside the folders assets may be read from (the project directory and assets({ roots })).`;
  }
  const inRoot = path.relative(root, real);
  if (hasDotSegment(inRoot)) {
    return `"${shown}" is a dotfile or inside a dot-folder; such files are never copied.`;
  }
  if (hasNodeModulesSegment(inRoot)) {
    return `"${shown}" is inside node_modules; add the package folder to assets({ roots }) to copy files from it.`;
  }
  const extension = path.extname(real).toLowerCase();
  const allowed = host.host.extensions;
  if (allowed && !allowed.includes(extension)) {
    return `"${shown}" has extension "${extension || "(none)"}", which assets({ extensions }) does not allow.`;
  }
  return undefined;
}

/** Real paths looked up for stored assets, per build. */
const storedRealPaths = new WeakMap<
  FieldSession,
  Map<string, Promise<boolean>>
>();

/**
 * True when an asset read from a cache file may be used as it is: its path
 * is a real path the asset rules allow, and its name, URL and type are the
 * ones this build gives a file with that path and hash. No content is
 * read: the caller has proved the file unchanged. A cache file is not
 * trusted to name a file the rules refuse.
 */
export async function storedAssetAllowed(
  session: FieldSession,
  asset: AssetRef,
): Promise<boolean> {
  const real = asset.sourcePath;
  if (assetPathProblem(session, real, real) !== undefined) return false;
  const fileName = assetFileName(path.basename(real), asset.hash);
  if (
    asset.fileName !== fileName ||
    asset.src !==
      `${session.publicBase ?? ""}${encodeURIComponent(fileName)}` ||
    asset.contentType !== contentTypeForPath(real)
  ) {
    return false;
  }
  let known = storedRealPaths.get(session);
  if (!known) {
    known = new Map();
    storedRealPaths.set(session, known);
  }
  let pending = known.get(real);
  if (!pending) {
    pending = realpath(real).then(
      (resolved) => resolved === real,
      () => false,
    );
    known.set(real, pending);
  }
  return pending;
}

/** Check a file against the asset rules and describe it. */
async function checkAssetFile(
  session: FieldSession,
  absolutePath: string,
): Promise<AssetRef> {
  const { project } = session;
  const shown = relativeTo(project.projectDir, absolutePath);
  const host = project.assetHost;
  if (!host || session.publicBase === undefined) {
    throw new Error(
      `"${shown}" is a local file, but no plugin handles assets. Add assets() from @anhur/assets to defineConfig({ plugins }).`,
    );
  }
  let real: string;
  try {
    real = await realpath(absolutePath);
  } catch {
    throw new Error(`File not found: ${shown}`);
  }
  const problem = assetPathProblem(session, real, shown);
  if (problem !== undefined) throw new Error(problem);
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`"${shown}" is not a file.`);
  }
  rememberSignature(session.stats, real, {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: info.ino,
    isFile: true,
  });
  const extension = path.extname(real).toLowerCase();
  const version = host.host.transformVersion?.(extension);
  const hash = await hashFile(session, real, info, version);
  const fileName = assetFileName(path.basename(real), hash);
  return {
    src: `${session.publicBase}${encodeURIComponent(fileName)}`,
    sourcePath: real,
    fileName,
    hash,
    size: info.size,
    contentType: contentTypeForPath(real),
  };
}

/**
 * Check and register a file as an asset. Shared by field contexts and by
 * cache replay, so both apply the same rules. A file is checked once per
 * build, however many documents use it.
 */
export async function emitAssetFile(
  session: FieldSession,
  absolutePath: string,
  recorder: EffectRecorder,
): Promise<AssetRef> {
  let pending = session.emitted.get(absolutePath);
  if (!pending) {
    pending = checkAssetFile(session, absolutePath);
    session.emitted.set(absolutePath, pending);
  }
  const asset = await pending;
  recorder.assets.set(asset.sourcePath, asset);
  return asset;
}

/** Explicit context for one field of one document. */
export function createFieldContext(
  session: FieldSession,
  file: SourceFile,
  body: string | undefined,
  fieldPath: FieldPath,
  recorder: EffectRecorder,
  shares: DocumentShares = createDocumentShares(),
): FieldContext {
  const emitAsset = (absolutePath: string): Promise<AssetRef> =>
    emitAssetFile(session, path.resolve(absolutePath), recorder);

  /**
   * A relative `link` points at a page (left for the host app) unless it
   * names a file: a known file type or one of the host's extensions (see
   * `isDocumentLinkPath`). `./release-1.0`, `./other.html` and `../guide/`
   * are pages; `./spec.pdf` is copied (or refused when not allowed).
   */
  const isPageLink = (relativePath: string): boolean =>
    isDocumentLinkPath(
      relativePath,
      session.project.assetHost?.host.extensions,
    );

  const resolveLink = async (
    url: string,
    role: LinkRole,
  ): Promise<ResolvedLink> => {
    const classified = classifyUrl(url);
    if (classified.kind !== "relative") return { kind: "external", url };
    if (role === "link" && isPageLink(classified.path)) {
      return { kind: "document", url, path: classified.path };
    }
    const asset = await emitAsset(
      path.resolve(path.dirname(file.absPath), classified.path),
    );
    return { kind: "asset", url: `${asset.src}${classified.suffix}`, asset };
  };

  return {
    document: {
      id: file.id,
      locale: file.locale,
      source: file.source.name,
      filePath: file.absPath,
      meta: file.meta,
    },
    fieldPath,
    body,
    projectDir: session.project.projectDir,
    mode: session.project.mode,
    configFingerprint: session.project.fingerprint,
    getPlugin: (name) =>
      session.project.plugins.find((plugin) => plugin.name === name),
    resolveLink,
    emitAsset,
    addDependency: (absolutePath) => {
      recorder.dependencies.add(path.resolve(absolutePath));
    },
    warn: (message) => {
      recorder.warnings.push(message);
    },
    share: async <TValue>(
      key: string,
      compute: (context: FieldContext) => TValue | Promise<TValue>,
    ): Promise<TValue> => {
      let shared = shares.values.get(key);
      if (!shared) {
        const effects = createEffectRecorder();
        const context = createFieldContext(
          session,
          file,
          body,
          fieldPath,
          effects,
          shares,
        );
        shared = {
          effects,
          value: Promise.resolve().then(() => compute(context)),
        };
        shares.values.set(key, shared);
      }
      // SAFETY: a key stands for one computation, so for one type of value.
      const value = (await shared.value) as TValue;
      mergeEffects(shared.effects, recorder);
      return value;
    },
    isShared: (key) => shares.announced.has(key),
  };
}
