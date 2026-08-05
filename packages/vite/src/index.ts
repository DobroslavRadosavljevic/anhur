import { createReadStream, existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import type { Connect, Plugin, UserConfig } from "vite";
import {
  build,
  formatAnhurError,
  resolveAssetsConfig,
  resolveConfigPath,
  watch,
  type AnhurConfig,
} from "@anhur/core";

export type AnhurViteOptions = {
  /** Path to config relative to Vite root (default `anhur.config.ts`). */
  configPath?: string;
};

const IMPORT_ID = "anhur/generated";

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

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
  let watchController: Awaited<ReturnType<typeof watch>> | undefined;
  let initialBuild: Promise<void> | undefined;

  function syncAssetsFromConfig(config: AnhurConfig) {
    const resolved = resolveAssetsConfig(config, configDir);
    if (!resolved) {
      assetsDir = "";
      return;
    }
    assetsDir = resolved.dir;
    assetsBase = resolved.base;
  }

  async function runBuild() {
    const result = await build({ rootDir, configPath: configFileName });
    outputDir = result.outputDir;
    syncAssetsFromConfig(result.config);
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
            ignored: ["!**/.anhur/generated/**", "!**/.anhur/assets/**"],
          },
        },
      };

      return patch;
    },

    async buildStart() {
      initialBuild ??= runBuild();
      await initialBuild;
    },

    async configureServer(server) {
      // Always mount; getters pick up assetsDir after buildStart/runBuild.
      server.middlewares.use(
        serveAssetsMiddleware(
          () => assetsDir,
          () => assetsBase,
        ),
      );

      // Dev server may hit assets before buildStart — warm the build here too.
      initialBuild ??= runBuild();
      await initialBuild;

      watchController = await watch(
        { rootDir, configPath: configFileName, immediate: false },
        {
          onBuild: async (result) => {
            outputDir = result.outputDir;
            syncAssetsFromConfig(result.config);
            const mod = server.moduleGraph.getModuleById(IMPORT_ID);
            const byPath = [...server.moduleGraph.urlToModuleMap.entries()]
              .filter(
                ([url]) =>
                  url.includes("anhur/generated") ||
                  url.includes(".anhur/generated"),
              )
              .map(([, m]) => m);

            const modules = [mod, ...byPath].filter(Boolean);
            for (const module of modules) {
              if (module) {
                server.moduleGraph.invalidateModule(module);
              }
            }

            server.ws.send({ type: "full-reload" });
          },
          onError: (error) => {
            server.config.logger.error(`[anhur] ${formatAnhurError(error)}`);
          },
        },
      );

      server.httpServer?.once("close", () => {
        void watchController?.close();
      });
    },

    async writeBundle(outputOptions) {
      if (!assetsDir || !existsSync(assetsDir)) return;
      const outDir = outputOptions.dir;
      if (!outDir) return;
      const basePath = assetsBase.replace(/^\//, "").replace(/\/$/, "");
      const target = path.join(outDir, basePath);
      await cp(assetsDir, target, { recursive: true });
    },

    async closeBundle() {
      await watchController?.close();
      watchController = undefined;
    },
  };
}

export default anhur;
