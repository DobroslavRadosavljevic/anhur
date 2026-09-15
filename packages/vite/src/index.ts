import { createReadStream, existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import type { Connect, Logger, Plugin, UserConfig } from "vite";
import {
  assetsOutDirSegment,
  build,
  loadConfig,
  relativeAssetRequestPath,
  resolveConfigPath,
  type BuildResult,
} from "@anhur/core";
import { formatAnhurBuildLog, type BuildLogKind } from "./build-log";
import { contentTypeFor } from "./content-type";
import {
  IMPORT_ID,
  attachAnhurDevWatcher,
  invalidateGeneratedModules,
  sendFullReload,
  syncViteWatchRoots,
  watchRootsFromBuild,
  type DevWatchState,
} from "./dev-watch";

export type AnhurViteOptions = {
  /** Path to config relative to Vite root (default `anhur.config.ts`). */
  configPath?: string;
};

/**
 * Resolve a request path under `assetsDir`, or `null` when it is unsafe /
 * not decodable.
 */
export function resolveServedAssetPath(
  assetsDir: string,
  relativeUrl: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativeUrl);
  } catch {
    return null;
  }
  const filePath = path.resolve(assetsDir, decoded.replace(/^\/+/, ""));
  const dir = path.resolve(assetsDir);
  if (filePath !== dir && !filePath.startsWith(dir + path.sep)) {
    return null;
  }
  return filePath;
}

/**
 * Serve copied assets. Reads dir/base via getters so registration can happen
 * before the first build finishes (`configureServer` runs before `buildStart`).
 */
function serveAssetsMiddleware(
  getAssetsDir: () => string,
  getAssetPrefixes: () => readonly (string | undefined)[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const assetsDir = getAssetsDir();
    if (!assetsDir) {
      next();
      return;
    }

    const relative = relativeAssetRequestPath(
      req.url ?? "",
      getAssetPrefixes(),
    );
    if (relative === null) {
      next();
      return;
    }
    const filePath = resolveServedAssetPath(assetsDir, relative);
    if (
      filePath === null ||
      !existsSync(filePath) ||
      !statSync(filePath).isFile()
    ) {
      next();
      return;
    }
    res.setHeader("Content-Type", contentTypeFor(filePath));
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) next();
      else res.end();
    });
    stream.pipe(res);
  };
}

export function anhur(options: AnhurViteOptions = {}): Plugin {
  const configFileName = options.configPath ?? "anhur.config.ts";
  let rootDir = process.cwd();
  let outputDir = "";
  let configDir = "";
  let assetsDir = "";
  let assetsPublicBase = "/anhur-assets/";
  let assetsLocalBase = "";
  let publicPathPrefix = "/";
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

  function applyBuildResult(result: BuildResult) {
    outputDir = result.outputDir;
    const assets = result.assets;
    if (!assets) {
      assetsDir = "";
      assetsLocalBase = "";
      return;
    }
    assetsDir = assets.dir;
    assetsPublicBase = assets.base;
    assetsLocalBase = assets.localBase ?? "";
  }

  async function runBuild(kind: BuildLogKind = "built"): Promise<BuildResult> {
    const result = await build({
      rootDir,
      configPath: configFileName,
      publicPathPrefix,
    });
    applyBuildResult(result);
    logBuild(result, kind);
    return result;
  }

  return {
    name: "anhur",

    async config(userConfig) {
      rootDir = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      const absoluteConfig = resolveConfigPath(rootDir, configFileName);
      configDir = path.dirname(absoluteConfig);
      outputDir = path.resolve(configDir, ".anhur/generated");
      try {
        const loaded = await loadConfig({
          rootDir,
          configPath: configFileName,
        });
        outputDir = path.resolve(
          configDir,
          loaded.config.outputDir ?? ".anhur/generated",
        );
      } catch {
        // Invalid/missing config: keep the default alias until buildStart.
      }

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
      publicPathPrefix = resolved.base;
    },

    async buildStart() {
      initialBuild ??= runBuild("built");
      await initialBuild;
    },

    async configureServer(server) {
      logger = server.config.logger;
      publicPathPrefix = server.config.base;

      server.middlewares.use(
        serveAssetsMiddleware(
          () => assetsDir,
          () => [assetsPublicBase, assetsLocalBase],
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
        publicPathPrefix,
        getWatchState: () => watchState,
        onBuildResult: async (next) => {
          applyBuildResult(next);
          logBuild(next, "rebuilt");
          invalidateGeneratedModules(server, IMPORT_ID, outputDir);
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
      // Remote configured `assets.base`: files live on the CDN, not in outDir.
      if (!assetsLocalBase) return;
      const outDir = outputOptions.dir;
      if (!outDir) return;
      const segment = assetsOutDirSegment(assetsLocalBase);
      if (!segment) return;
      const target = path.join(outDir, segment);
      await cp(assetsDir, target, { recursive: true });
    },

    async closeBundle() {
      disposeWatcher?.();
      disposeWatcher = undefined;
    },
  };
}

export default anhur;
