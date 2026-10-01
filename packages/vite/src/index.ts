import path from "node:path";
import type { HotPayload, Logger, Plugin, ViteDevServer } from "vite";
import {
  createAnhur,
  isAnhurBuildError,
  isRelevantChange,
  type AnhurSession,
  type BuildResult,
  type WatchTargets,
} from "@anhur/core/build";
import { formatBuildLog } from "./build-log";
import { copyAssetsToOutput } from "./output-assets";
import { serveAssets, type AssetRoute } from "./serve-assets";

/** Import specifier of the generated modules. */
export const IMPORT_ID = "anhur/generated";
const DEBOUNCE_MS = 75;

export type AnhurViteOptions = {
  /** Config file relative to the Vite root. Default: `anhur.config.{ts,mts,js,mjs}`. */
  readonly configPath?: string;
};

function errorMessage(cause: unknown): string {
  if (isAnhurBuildError(cause)) return cause.message;
  if (cause instanceof Error) return cause.stack ?? cause.message;
  return String(cause);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function assetRoute(
  result: BuildResult | undefined,
  base: string,
): AssetRoute | undefined {
  const assets = result?.assets;
  if (!assets?.dir || assets.localBase === undefined) return undefined;
  const prefixes = new Set([assets.localBase]);
  if (assets.publicBase.startsWith("/")) prefixes.add(assets.publicBase);
  if (base.startsWith("/") && base !== "/") {
    prefixes.add(`${base.replace(/\/$/, "")}${assets.localBase}`);
  }
  return { dir: assets.dir, prefixes: [...prefixes] };
}

/** True when `file` is output Anhur itself writes (generated modules, copied assets). */
function isAnhurOutput(file: string, result: BuildResult): boolean {
  if (isInside(file, result.outputDir)) return true;
  const assetsDir = result.assets?.dir;
  return assetsDir !== undefined && isInside(file, assetsDir);
}

function sendToClient(server: ViteDevServer, payload: HotPayload): void {
  const client = server.environments?.client;
  if (client) client.hot.send(payload);
  else server.ws.send(payload);
}

/**
 * Rebuild state of one dev server. `server.restart()` creates a new server
 * (reusing an inline plugin instance) before the old one closes, so every
 * piece of dev state belongs to its server, never to the plugin.
 */
type DevServerState = {
  readonly session: AnhurSession;
  disposed: boolean;
  /** False until the first build finished; file events are queued until then. */
  ready: boolean;
  readonly early: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
  building: boolean;
  pending: boolean;
  failing: boolean;
  readonly added: Set<string>;
  targets: WatchTargets;
  release: () => Promise<void>;
};

/**
 * Vite plugin for Anhur.
 *
 * - builds content before the app (`vite dev` / `vite build`, also `--watch`)
 * - resolves `import … from "anhur/generated"` to the generated modules
 * - rebuilds on content / config changes; only changed modules are rewritten,
 *   so Vite's own file watching drives HMR
 * - shows build errors in the browser overlay and keeps the server running
 * - serves copied assets in dev and copies them into the client build
 *
 * Add `"anhur/generated": ["./.anhur/generated"]` to tsconfig `paths`.
 */
export function anhur(options: AnhurViteOptions = {}): Plugin {
  let rootDir = process.cwd();
  let mode: "dev" | "build" = "dev";
  let base = "/";
  let logger: Logger | undefined;
  let session: AnhurSession | undefined;
  let sessionKey = "";
  let result: BuildResult | undefined;
  let buildOnce: Promise<BuildResult> | undefined;
  /** Dev servers using each session; a session closes with its last server. */
  const users = new Map<AnhurSession, number>();
  /** Dev server state by Vite environment (`closeBundle` runs per environment). */
  const serverStates = new WeakMap<object, DevServerState>();
  /** Files Rollup reported changed since the last `--watch` build. */
  const changed = new Set<string>();

  const log = (line: string) => {
    if (logger) logger.info(line, { timestamp: true });
    else console.info(line);
  };

  const closeSession = (closing: AnhurSession) => {
    closing.close().catch((cause: unknown) => {
      log(`[anhur] closing the content session failed: ${errorMessage(cause)}`);
    });
  };

  /** Close `previous` now, or when the last dev server using it closes. */
  const retire = (previous: AnhurSession) => {
    if ((users.get(previous) ?? 0) === 0) closeSession(previous);
  };

  const currentSession = (): AnhurSession => {
    if (!session) {
      throw new Error(
        "[anhur] the plugin was used before Vite resolved its config.",
      );
    }
    return session;
  };

  const runBuild = async (
    target: AnhurSession,
    kind: "built" | "rebuilt",
  ): Promise<BuildResult> => {
    const started = performance.now();
    const next = await target.build();
    result = next;
    for (const line of formatBuildLog(next, kind, performance.now() - started))
      log(line);
    return next;
  };

  const generatedIndex = () =>
    path.join(
      result?.outputDir ?? path.join(rootDir, ".anhur", "generated"),
      "index.js",
    );

  return {
    name: "anhur",
    enforce: "pre",

    config() {
      return { optimizeDeps: { exclude: [IMPORT_ID] } };
    },

    configResolved(config) {
      rootDir = config.root;
      mode = config.command === "build" ? "build" : "dev";
      base = config.base;
      logger = config.logger;
      const key = `${rootDir}\u0000${mode}\u0000${base}\u0000${options.configPath ?? ""}`;
      if (session && sessionKey !== key) {
        retire(session);
        session = undefined;
        buildOnce = undefined;
        result = undefined;
      }
      sessionKey = key;
      session ??= createAnhur({
        rootDir,
        configPath: options.configPath,
        mode,
        publicPathPrefix: base,
      });
    },

    resolveId(id) {
      return id === IMPORT_ID ? generatedIndex() : null;
    },

    watchChange(id) {
      if (mode === "build") changed.add(path.resolve(id));
    },

    async buildStart() {
      if (mode !== "build") return;
      try {
        if (this.meta.watchMode) {
          // Rollup also rebuilds when Anhur's own output changed during the
          // previous build; that needs no new content build.
          const files = [...changed];
          changed.clear();
          const previous = result;
          const next =
            previous &&
            files.length > 0 &&
            files.every((file) => isAnhurOutput(file, previous))
              ? previous
              : await runBuild(
                  currentSession(),
                  previous ? "rebuilt" : "built",
                );
          for (const target of [
            ...next.watch.directories,
            ...next.watch.files,
          ]) {
            this.addWatchFile(target);
          }
        } else {
          buildOnce ??= runBuild(currentSession(), "built");
          await buildOnce;
        }
      } catch (cause) {
        this.error(errorMessage(cause));
      }
    },

    async configureServer(server) {
      const owned = currentSession();
      users.set(owned, (users.get(owned) ?? 0) + 1);
      const state: DevServerState = {
        session: owned,
        disposed: false,
        ready: false,
        early: [],
        timer: undefined,
        building: false,
        pending: false,
        failing: false,
        added: new Set<string>(),
        targets: { directories: [], files: [], ignore: [] },
        release: async () => {
          if (state.disposed) return;
          state.disposed = true;
          if (state.timer) clearTimeout(state.timer);
          const remaining = (users.get(owned) ?? 1) - 1;
          if (remaining > 0) {
            users.set(owned, remaining);
            return;
          }
          users.delete(owned);
          if (session === owned) {
            session = undefined;
            sessionKey = "";
            buildOnce = undefined;
          }
          await owned.close();
        },
      };
      for (const environment of Object.values(server.environments ?? {})) {
        serverStates.set(environment, state);
      }
      server.httpServer?.once("close", () => {
        void state.release();
      });
      server.middlewares.use(serveAssets(() => assetRoute(result, base)));

      const syncWatched = async () => {
        if (state.disposed) return;
        const targets = await owned.watchTargets();
        state.targets = targets;
        const wanted = new Set<string>();
        for (const target of [...targets.directories, ...targets.files]) {
          if (!isInside(target, rootDir)) wanted.add(target);
        }
        if (result && !isInside(result.outputDir, rootDir))
          wanted.add(result.outputDir);
        for (const target of state.added) {
          if (!wanted.has(target)) {
            server.watcher.unwatch(target);
            state.added.delete(target);
          }
        }
        for (const target of wanted) {
          if (!state.added.has(target)) {
            server.watcher.add(target);
            state.added.add(target);
          }
        }
      };

      const reportError = (cause: unknown) => {
        const message = errorMessage(cause);
        server.config.logger.error(`[anhur] ${message}`, { timestamp: true });
        state.failing = true;
        sendToClient(server, {
          type: "error",
          err: {
            message: message.replace(/^Anhur build failed[^\n]*\n/, ""),
            stack: "",
            plugin: "anhur",
            id: isAnhurBuildError(cause)
              ? cause.diagnostics[0]?.file
              : undefined,
          },
        });
      };

      const rebuild = async () => {
        state.pending = true;
        if (state.building) return;
        while (state.pending && !state.disposed) {
          state.pending = false;
          state.building = true;
          try {
            const next = await runBuild(owned, "rebuilt");
            if (state.failing && next.written.length === 0) {
              sendToClient(server, { type: "full-reload" });
            }
            state.failing = false;
          } catch (cause) {
            reportError(cause);
          } finally {
            state.building = false;
          }
          await syncWatched().catch((cause: unknown) => reportError(cause));
        }
      };

      const schedule = () => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = undefined;
          void rebuild();
        }, DEBOUNCE_MS);
      };

      const onFileEvent = (file: string) => {
        if (state.disposed) return;
        const absolute = path.resolve(file);
        if (!state.ready) {
          state.early.push(absolute);
          return;
        }
        if (isRelevantChange(absolute, state.targets)) schedule();
      };
      server.watcher.on("add", onFileEvent);
      server.watcher.on("change", onFileEvent);
      server.watcher.on("unlink", onFileEvent);

      try {
        await runBuild(owned, "built");
      } catch (cause) {
        reportError(cause);
      }
      await syncWatched().catch((cause: unknown) => reportError(cause));
      state.ready = true;
      const early = state.early.splice(0);
      if (
        !state.disposed &&
        early.some((file) => isRelevantChange(file, state.targets))
      ) {
        schedule();
      }
    },

    // A dev server closes its plugin containers on `server.close()` (also in
    // middleware mode, which has no HTTP server), once per environment.
    // Release that server's state; the session closes with its last server.
    // Builds keep the session for `--watch` and later environments.
    async closeBundle() {
      if (mode !== "dev") return;
      const state = serverStates.get(this.environment);
      if (state) await state.release();
    },

    async writeBundle(outputOptions) {
      if (this.environment && this.environment.config.consumer !== "client")
        return;
      const assets = result?.assets;
      if (!assets?.dir || assets.localBase === undefined || !outputOptions.dir)
        return;
      await copyAssetsToOutput(assets.dir, assets.localBase, outputOptions.dir);
    },
  };
}

export default anhur;
