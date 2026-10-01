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
};

export function createEffectRecorder(): EffectRecorder {
  return { assets: new Map(), dependencies: new Set(), warnings: [] };
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

/** Native real path (on-disk case), or the path itself when it does not exist. */
async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/** The most specific allowed root that contains `real`. */
async function matchingRoot(
  session: FieldSession,
  real: string,
): Promise<string | undefined> {
  const roots = await Promise.all(session.assetRoots.map(realRoot));
  let best: string | undefined;
  for (const root of roots) {
    if (!isInside(real, root)) continue;
    if (best === undefined || root.length > best.length) best = root;
  }
  return best;
}

function hasNodeModulesSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).includes("node_modules");
}

/**
 * Check and register a file as an asset. Shared by field contexts and by
 * cache replay, so both apply the same rules.
 */
export async function emitAssetFile(
  session: FieldSession,
  absolutePath: string,
  recorder: EffectRecorder,
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
  const root = await matchingRoot(session, real);
  if (!root) {
    throw new Error(
      `"${shown}" is outside the folders assets may be read from (the project directory and assets({ roots })).`,
    );
  }
  const inRoot = path.relative(root, real);
  if (hasDotSegment(inRoot)) {
    throw new Error(
      `"${shown}" is a dotfile or inside a dot-folder; such files are never copied.`,
    );
  }
  if (hasNodeModulesSegment(inRoot)) {
    throw new Error(
      `"${shown}" is inside node_modules; add the package folder to assets({ roots }) to copy files from it.`,
    );
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`"${shown}" is not a file.`);
  }
  const extension = path.extname(real).toLowerCase();
  const allowed = host.host.extensions;
  if (allowed && !allowed.includes(extension)) {
    throw new Error(
      `"${shown}" has extension "${extension || "(none)"}", which assets({ extensions }) does not allow.`,
    );
  }
  const version = host.host.transformVersion?.(extension);
  const hash = await hashFile(session, real, info, version);
  const fileName = assetFileName(path.basename(real), hash);
  const asset: AssetRef = {
    src: `${session.publicBase}${encodeURIComponent(fileName)}`,
    sourcePath: real,
    fileName,
    hash,
    size: info.size,
    contentType: contentTypeForPath(real),
  };
  recorder.assets.set(real, asset);
  return asset;
}

/** Explicit context for one field of one document. */
export function createFieldContext(
  session: FieldSession,
  file: SourceFile,
  body: string | undefined,
  fieldPath: FieldPath,
  recorder: EffectRecorder,
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
  };
}
