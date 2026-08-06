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
 * Absolute paths Anhur should watch for rebuilds: the config file plus each
 * collection/singleton content root.
 */
export function collectWatchPaths(
  config: AnhurConfig,
  rootDir: string,
  absoluteConfigPath: string,
): string[] {
  const watchPaths = new Set<string>([canonicalizePath(absoluteConfigPath)]);

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

  return [...watchPaths];
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
