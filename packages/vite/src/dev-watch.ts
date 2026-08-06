import path from "node:path";
import type { ModuleNode, ViteDevServer } from "vite";
import {
  build,
  collectWatchPaths,
  formatAnhurError,
  isAnhurWatchTarget,
  resolveAssetsConfig,
  resolveConfigPath,
  type AnhurConfig,
  type BuildResult,
} from "@anhur/core";

export const IMPORT_ID = "anhur/generated";

export const REBUILD_DEBOUNCE_MS = 50;

export function syncAssetsFromConfig(
  config: AnhurConfig,
  configDir: string,
): { dir: string; base: string } | null {
  return resolveAssetsConfig(config, configDir) ?? null;
}

export function invalidateGeneratedModules(
  server: ViteDevServer,
  importId = IMPORT_ID,
): void {
  const mod = server.moduleGraph.getModuleById(importId);
  const byPath = [...server.moduleGraph.urlToModuleMap.entries()]
    .filter(
      ([url]) =>
        url.includes("anhur/generated") || url.includes(".anhur/generated"),
    )
    .map(([, m]) => m);

  const modules = [mod, ...byPath].filter(Boolean) as ModuleNode[];
  for (const module of modules) {
    server.moduleGraph.invalidateModule(module);
  }
}

export function sendFullReload(server: ViteDevServer): void {
  server.ws.send({ type: "full-reload" });
}

export type DevWatchState = {
  watchRoots: string[];
};

/**
 * Keep Vite's watcher subscribed to Anhur config + content roots.
 */
export function syncViteWatchRoots(
  server: ViteDevServer,
  state: DevWatchState,
  nextRoots: readonly string[],
): void {
  const next = new Set(nextRoots.map((p) => path.resolve(p)));
  for (const prev of state.watchRoots) {
    if (!next.has(prev)) {
      server.watcher.unwatch(prev);
    }
  }
  for (const root of next) {
    if (!state.watchRoots.includes(root)) {
      server.watcher.add(root);
    }
  }
  state.watchRoots = [...next];
}

export function watchRootsFromBuild(
  result: BuildResult,
  rootDir: string,
  configFileName: string,
): string[] {
  const absoluteConfig = resolveConfigPath(rootDir, configFileName);
  return collectWatchPaths(result.config, rootDir, absoluteConfig);
}

export type AttachDevWatcherOptions = {
  server: ViteDevServer;
  rootDir: string;
  configFileName: string;
  debounceMs?: number;
  onBuildResult: (result: BuildResult) => void | Promise<void>;
  getWatchState: () => DevWatchState;
};

/**
 * Rebuild Anhur when Vite's watcher sees config or content changes.
 * Returns a disposer that removes listeners (does not close Vite's watcher).
 */
export function attachAnhurDevWatcher(
  options: AttachDevWatcherOptions,
): () => void {
  const {
    server,
    rootDir,
    configFileName,
    debounceMs = REBUILD_DEBOUNCE_MS,
    onBuildResult,
    getWatchState,
  } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let building = false;
  let pending = false;
  let disposed = false;

  const runRebuild = async () => {
    if (disposed) return;
    pending = true;
    if (building) return;

    while (pending && !disposed) {
      pending = false;
      building = true;
      try {
        const result = await build({ rootDir, configPath: configFileName });
        const roots = watchRootsFromBuild(result, rootDir, configFileName);
        syncViteWatchRoots(server, getWatchState(), roots);
        await onBuildResult(result);
      } catch (error) {
        server.config.logger.error(`[anhur] ${formatAnhurError(error)}`);
      } finally {
        building = false;
      }
    }
  };

  const scheduleRebuild = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runRebuild();
    }, debounceMs);
  };

  const onFsEvent = (file: string) => {
    if (disposed) return;
    if (!isAnhurWatchTarget(file, getWatchState().watchRoots)) return;
    scheduleRebuild();
  };

  server.watcher.on("change", onFsEvent);
  server.watcher.on("add", onFsEvent);
  server.watcher.on("unlink", onFsEvent);

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    server.watcher.off("change", onFsEvent);
    server.watcher.off("add", onFsEvent);
    server.watcher.off("unlink", onFsEvent);
  };
}
