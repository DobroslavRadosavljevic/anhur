import path from "node:path";
import type { ViteDevServer } from "vite";
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

/** Match virtual id, resolved url, or absolute `.anhur/generated` file path. */
export function isAnhurGeneratedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.includes("anhur/generated") || value.includes(".anhur/generated"))
  );
}

type GraphModule = {
  id?: string | null;
  url?: string;
  file?: string | null;
};

type ModuleGraphLike = {
  getModuleById?: (id: string) => GraphModule | undefined;
  idToModuleMap?: Map<string, GraphModule>;
  urlToModuleMap: Map<string, GraphModule>;
  // Vite graphs use concrete ModuleNode types; accept any module shape here.
  invalidateModule: (mod: GraphModule, seen?: Set<GraphModule>) => void;
};

type EnvironmentLike = {
  name: string;
  moduleGraph: ModuleGraphLike;
  hot?: { send?: (payload: { type: string }) => void };
  runner?: { clearCache?: () => void };
};

function asModuleGraphLike(graph: unknown): ModuleGraphLike {
  return graph as ModuleGraphLike;
}

function listEnvironments(server: ViteDevServer): EnvironmentLike[] {
  if (!server.environments) return [];
  return Object.values(server.environments) as unknown as EnvironmentLike[];
}

function invalidateGraphModules(
  graph: ModuleGraphLike,
  importId: string,
): void {
  const seen = new Set<GraphModule>();
  const modules = new Set<GraphModule>();

  const byId = graph.getModuleById?.(importId);
  if (byId) modules.add(byId);

  if (graph.idToModuleMap) {
    for (const mod of graph.idToModuleMap.values()) {
      if (
        isAnhurGeneratedId(mod.id) ||
        isAnhurGeneratedId(mod.url) ||
        isAnhurGeneratedId(mod.file)
      ) {
        modules.add(mod);
      }
    }
  }

  for (const [url, mod] of graph.urlToModuleMap) {
    if (isAnhurGeneratedId(url)) modules.add(mod);
  }

  for (const module of modules) {
    graph.invalidateModule(module, seen);
  }
}

/**
 * Invalidate Anhur generated modules in every Vite environment graph, then
 * clear non-client ModuleRunner caches so SSR re-imports fresh exports.
 */
export function invalidateGeneratedModules(
  server: ViteDevServer,
  importId = IMPORT_ID,
): void {
  for (const environment of listEnvironments(server)) {
    invalidateGraphModules(environment.moduleGraph, importId);

    if (
      environment.name !== "client" &&
      "runner" in environment &&
      typeof environment.runner?.clearCache === "function"
    ) {
      environment.runner.clearCache();
    }
  }

  // Legacy / compat mixed module graph (also present alongside environments).
  invalidateGraphModules(asModuleGraphLike(server.moduleGraph), importId);
}

/**
 * Full-reload every environment.hot channel (Vite 6+).
 * Falls back to server.ws when environments are unavailable.
 */
export function sendFullReload(server: ViteDevServer): void {
  const environments = listEnvironments(server);

  if (environments.length > 0) {
    for (const environment of environments) {
      environment.hot?.send?.({ type: "full-reload" });
    }
    return;
  }

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
