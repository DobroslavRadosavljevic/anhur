import { createReadStream, existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import type { Connect, Logger, Plugin, UserConfig } from "vite";
import {
  build,
  findProcessor,
  ASSETS_PROCESSOR_ID,
  resolveConfigPath,
  type AnhurConfig,
  type AssetsProcessorOptions,
  type BuildResult,
} from "@anhur/core";
import { formatAnhurBuildLog, type BuildLogKind } from "./build-log";
import { contentTypeFor } from "./content-type";
import {
  IMPORT_ID,
  attachAnhurDevWatcher,
  invalidateGeneratedModules,
  sendFullReload,
  syncAssetsFromConfig,
  syncViteWatchRoots,
  watchRootsFromBuild,
  type DevWatchState,
} from "./dev-watch";

export type AnhurViteOptions = {
  /** Path to config relative to Vite root (default `anhur.config.ts`). */
  configPath?: string;
};

/**
 * Serve copied assets. Reads dir/base via getters so registration can happen
 * before the first build finishes (`configureServer` runs before `buildStart`).
 */
function serveAssetsMiddleware(
  getAssetsDir: () => string,
  getAssetsBase: () => string,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const assetsDir = getAssetsDir();
    const base = getAssetsBase();
    if (!assetsDir || !base) {
      next();
      return;
    }

    const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
    const url = req.url ?? "";
    if (!url.startsWith(prefix)) {
      next();
      return;
    }
    const relative = decodeURIComponent(
      url.slice(prefix.length).split("?")[0] ?? "",
    );
    const filePath = path.join(assetsDir, relative.replace(/^\/+/, ""));
    if (
      !filePath.startsWith(assetsDir) ||
      !existsSync(filePath) ||
      !statSync(filePath).isFile()
    ) {
      next();
      return;
    }
    res.setHeader("Content-Type", contentTypeFor(filePath));
    createReadStream(filePath).pipe(res);
  };
}

export function anhur(options: AnhurViteOptions = {}): Plugin {
  const configFileName = options.configPath ?? "anhur.config.ts";
  let rootDir = process.cwd();
  let outputDir = "";
  let configDir = "";
  let assetsDir = "";
  let assetsBase = "/anhur-assets/";
  let assetsStorageEnabled = false;
  let initialBuild: Promise<BuildResult> | undefined;
  let disposeWatcher: (() => void) | undefined;
  let logger: Logger | undefined;
  const watchState: DevWatchState = { watchRoots: [] };

  function logBuild(result: BuildResult, kind: BuildLogKind) {
    const lines = formatAnhurBuildLog(result, kind, { rootDir });
    for (const line of lines) {
      if (logger) {
        logger.info(line, { timestamp: true });
      } else {
        console.info(line);
      }
    }
  }

  function applyBuildResult(config: AnhurConfig, nextOutputDir: string) {
    outputDir = nextOutputDir;
    const assets = syncAssetsFromConfig(config, configDir);
    const storage = (
      findProcessor(config.processors, ASSETS_PROCESSOR_ID)?.options as
        | AssetsProcessorOptions
        | undefined
    )?.storage;
    assetsStorageEnabled = storage?.enabled === true;
    if (!assets) {
      assetsDir = "";
      return;
    }
    assetsDir = assets.dir;
    assetsBase = assets.base;
  }

  async function runBuild(kind: BuildLogKind = "built"): Promise<BuildResult> {
    const result = await build({ rootDir, configPath: configFileName });
    applyBuildResult(result.config, result.outputDir);
    logBuild(result, kind);
    return result;
  }

  return {
    name: "anhur",

    config(userConfig) {
      rootDir = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      const absoluteConfig = resolveConfigPath(rootDir, configFileName);
      configDir = path.dirname(absoluteConfig);
      outputDir = path.resolve(configDir, ".anhur/generated");

      const patch: Partial<UserConfig> = {
        resolve: {
          alias: {
            [IMPORT_ID]: outputDir,
          },
        },
        optimizeDeps: {
          exclude: [IMPORT_ID],
        },
        server: {
          watch: {
            // Keep generated + assets visible to Vite; Anhur rebuilds only on
            // content/config paths subscribed via server.watcher.add.
            ignored: ["!**/.anhur/generated/**", "!**/.anhur/assets/**"],
          },
        },
      };

      return patch;
    },

    configResolved(resolved) {
      logger = resolved.logger;
    },

    async buildStart() {
      initialBuild ??= runBuild("built");
      await initialBuild;
    },

    async configureServer(server) {
      logger = server.config.logger;

      server.middlewares.use(
        serveAssetsMiddleware(
          () => assetsDir,
          () => assetsBase,
        ),
      );

      // Dev server may hit assets before buildStart — warm the build here too.
      initialBuild ??= runBuild("built");
      const result = await initialBuild;

      syncViteWatchRoots(
        server,
        watchState,
        watchRootsFromBuild(result, rootDir, configFileName),
      );

      disposeWatcher?.();
      disposeWatcher = attachAnhurDevWatcher({
        server,
        rootDir,
        configFileName,
        getWatchState: () => watchState,
        onBuildResult: async (next) => {
          applyBuildResult(next.config, next.outputDir);
          logBuild(next, "rebuilt");
          invalidateGeneratedModules(server);
          sendFullReload(server);
        },
      });

      const previousClose = server.close.bind(server);
      server.close = async () => {
        disposeWatcher?.();
        disposeWatcher = undefined;
        await previousClose();
      };
    },

    async writeBundle(outputOptions) {
      if (!assetsDir || !existsSync(assetsDir)) return;
      // CDN delivery: skip local outDir copy only when remote sync is enabled.
      if (assetsStorageEnabled && /^https?:\/\//i.test(assetsBase)) return;
      const outDir = outputOptions.dir;
      if (!outDir) return;
      const basePath = assetsBase.replace(/^\//, "").replace(/\/$/, "");
      const target = path.join(outDir, basePath);
      await cp(assetsDir, target, { recursive: true });
    },

    async closeBundle() {
      disposeWatcher?.();
      disposeWatcher = undefined;
    },
  };
}

export default anhur;
