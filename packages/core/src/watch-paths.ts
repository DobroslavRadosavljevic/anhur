import { realpathSync } from "node:fs";
import path from "node:path";
import {
  isCollection,
  isLocalized,
  isSingleton,
  type AnhurConfig,
} from "./config";

/** Resolve symlinks when possible so watch roots match Vite/chokidar paths. */
export function canonicalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Absolute paths Anhur should watch for rebuilds: the config file, the
 * conventional `cms/` module tree next to it, each collection/singleton
 * content root, and parent directories of `emitAsset` sources outside those roots.
 */
export function collectWatchPaths(
  config: AnhurConfig,
  rootDir: string,
  absoluteConfigPath: string,
  extraPaths: readonly string[] = [],
): string[] {
  const watchPaths = new Set<string>([canonicalizePath(absoluteConfigPath)]);
  const configDir = path.dirname(absoluteConfigPath);
  watchPaths.add(canonicalizePath(path.join(configDir, "cms")));

  for (const source of config.content) {
    if (isCollection(source)) {
      watchPaths.add(canonicalizePath(path.resolve(rootDir, source.directory)));
    } else if (isSingleton(source)) {
      if (isLocalized(config, source) && source.directory) {
        watchPaths.add(
          canonicalizePath(path.resolve(rootDir, source.directory)),
        );
      } else if (source.filePath) {
        watchPaths.add(
          canonicalizePath(path.resolve(rootDir, source.filePath)),
        );
      }
    }
  }

  addEmittedAssetWatchPaths(watchPaths, extraPaths);
  return [...watchPaths];
}

function addEmittedAssetWatchPaths(
  watchPaths: Set<string>,
  extraPaths: readonly string[],
): void {
  const existing = [...watchPaths];
  for (const extra of extraPaths) {
    const file = canonicalizePath(extra);
    if (existing.some((root) => isUnderWatchPath(file, root))) continue;
    const parent = path.dirname(file);
    if (parent === path.parse(parent).root) {
      watchPaths.add(file);
      continue;
    }
    watchPaths.add(canonicalizePath(parent));
  }
}

/** True when `filePath` is the watch root or a file inside it. */
export function isUnderWatchPath(filePath: string, watchRoot: string): boolean {
  const file = canonicalizePath(filePath);
  const root = canonicalizePath(watchRoot);
  return file === root || file.startsWith(root + path.sep);
}

/** True when `filePath` matches any Anhur watch root. */
export function isAnhurWatchTarget(
  filePath: string,
  watchRoots: readonly string[],
): boolean {
  return watchRoots.some((root) => isUnderWatchPath(filePath, root));
}
