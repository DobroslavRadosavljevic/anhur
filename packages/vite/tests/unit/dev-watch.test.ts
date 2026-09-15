import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { canonicalizePath } from "@anhur/core";

function isViteDevServer<T extends object>(
  value: T,
): value is T & ViteDevServer {
  return (
    "watcher" in value ||
    "ws" in value ||
    "environments" in value ||
    "moduleGraph" in value
  );
}
import {
  IMPORT_ID,
  invalidateGeneratedModules,
  isAnhurGeneratedId,
  sendFullReload,
  syncViteWatchRoots,
  type DevWatchState,
} from "../../src/dev-watch";

function createGraph(entries: {
  byId?: Record<string, { id?: string; url?: string; file?: string }>;
  byUrl?: Record<string, { id?: string; url?: string; file?: string }>;
}) {
  const idToModuleMap = new Map(
    Object.entries(entries.byId ?? {}).map(([id, mod]) => [id, { id, ...mod }]),
  );
  const urlToModuleMap = new Map(
    Object.entries(entries.byUrl ?? {}).map(([url, mod]) => [
      url,
      { url, ...mod },
    ]),
  );
  const invalidateModule = vi.fn();
  return {
    getModuleById: (id: string) => idToModuleMap.get(id),
    idToModuleMap,
    urlToModuleMap,
    invalidateModule,
  };
}

describe("dev-watch helpers", () => {
  it("exposes IMPORT_ID", () => {
    expect(IMPORT_ID).toBe("anhur/generated");
  });

  it("isAnhurGeneratedId matches virtual and absolute generated paths", () => {
    expect(isAnhurGeneratedId("anhur/generated")).toBe(true);
    expect(isAnhurGeneratedId("/proj/.anhur/generated/index.js")).toBe(true);
    expect(isAnhurGeneratedId("/proj/src/app.tsx")).toBe(false);
    expect(isAnhurGeneratedId(null)).toBe(false);
    expect(isAnhurGeneratedId("/proj/generated/index.js")).toBe(false);
    expect(
      isAnhurGeneratedId("/proj/generated/index.js", "/proj/generated"),
    ).toBe(true);
    expect(
      isAnhurGeneratedId("/proj/generated-backup/x.js", "/proj/generated"),
    ).toBe(false);
  });

  it("syncViteWatchRoots adds and removes watcher paths", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const server = {
      watcher: {
        add: (p: string) => {
          added.push(p);
        },
        unwatch: (p: string) => {
          removed.push(p);
        },
      },
    };
    if (!isViteDevServer(server)) {
      throw new Error("expected ViteDevServer fixture");
    }

    const state: DevWatchState = { watchRoots: [] };
    const a = canonicalizePath("/tmp/a");
    const b = canonicalizePath("/tmp/b");
    const c = canonicalizePath("/tmp/c");

    syncViteWatchRoots(server, state, [a, b]);
    expect(added).toEqual([a, b]);
    expect(state.watchRoots).toEqual([a, b]);

    added.length = 0;
    syncViteWatchRoots(server, state, [b, c]);
    expect(removed).toEqual([a]);
    expect(added).toEqual([c]);
    expect(state.watchRoots).toEqual([b, c]);
  });

  it("invalidateGeneratedModules invalidates matching legacy module graph entries", () => {
    const mod = { id: IMPORT_ID };
    const invalidateModule = vi.fn();
    const server = {
      moduleGraph: {
        getModuleById: (id: string) => (id === IMPORT_ID ? mod : undefined),
        urlToModuleMap: new Map([
          ["anhur/generated", mod],
          ["/src/app.tsx", { id: "app" }],
        ]),
        invalidateModule,
      },
    };
    if (!isViteDevServer(server)) {
      throw new Error("expected ViteDevServer fixture");
    }

    invalidateGeneratedModules(server);
    expect(invalidateModule).toHaveBeenCalled();
  });

  it("invalidateGeneratedModules invalidates per-environment graphs and clears non-client runners", () => {
    const generated = {
      id: "/proj/.anhur/generated/index.js",
      url: "anhur/generated",
      file: "/proj/.anhur/generated/index.js",
    };
    const clientGraph = createGraph({
      byId: { [generated.id]: generated },
      byUrl: { "anhur/generated": generated },
    });
    const ssrGraph = createGraph({
      byId: { [generated.id]: generated },
      byUrl: { "anhur/generated": generated },
    });
    const clientClearCache = vi.fn();
    const ssrClearCache = vi.fn();
    const legacyInvalidate = vi.fn();

    const server = {
      environments: {
        client: {
          name: "client",
          moduleGraph: clientGraph,
          runner: { clearCache: clientClearCache },
        },
        ssr: {
          name: "ssr",
          moduleGraph: ssrGraph,
          runner: { clearCache: ssrClearCache },
        },
      },
      moduleGraph: {
        getModuleById: () => undefined,
        urlToModuleMap: new Map(),
        invalidateModule: legacyInvalidate,
      },
    };
    if (!isViteDevServer(server)) {
      throw new Error("expected ViteDevServer fixture");
    }

    invalidateGeneratedModules(server);

    expect(clientGraph.invalidateModule).toHaveBeenCalled();
    expect(ssrGraph.invalidateModule).toHaveBeenCalled();
    expect(ssrClearCache).toHaveBeenCalledTimes(1);
    expect(clientClearCache).not.toHaveBeenCalled();
    expect(legacyInvalidate).not.toHaveBeenCalled();
  });

  it("invalidateGeneratedModules matches absolute .anhur/generated file ids", () => {
    const fileMod = {
      id: "/app/.anhur/generated/site.js",
      file: "/app/.anhur/generated/site.js",
    };
    const ssrGraph = createGraph({
      byId: { [fileMod.id]: fileMod },
    });
    const clearCache = vi.fn();

    const server = {
      environments: {
        ssr: {
          name: "ssr",
          moduleGraph: ssrGraph,
          runner: { clearCache },
        },
      },
      moduleGraph: {
        getModuleById: () => undefined,
        urlToModuleMap: new Map(),
        invalidateModule: vi.fn(),
      },
    };
    if (!isViteDevServer(server)) {
      throw new Error("expected ViteDevServer fixture");
    }

    invalidateGeneratedModules(server);
    expect(ssrGraph.invalidateModule).toHaveBeenCalledWith(
      expect.objectContaining({ file: fileMod.file }),
      expect.any(Set),
    );
    expect(clearCache).toHaveBeenCalled();
  });

  it("sendFullReload falls back to server.ws when environments are absent", () => {
    const send = vi.fn();
    const fixture = { ws: { send } };
    if (!isViteDevServer(fixture)) {
      throw new Error("expected ViteDevServer fixture");
    }
    const server = fixture;
    sendFullReload(server);
    expect(send).toHaveBeenCalledWith({ type: "full-reload" });
  });

  it("sendFullReload sends full-reload on each environment.hot", () => {
    const clientSend = vi.fn();
    const ssrSend = vi.fn();
    const wsSend = vi.fn();
    const server = {
      environments: {
        client: { name: "client", hot: { send: clientSend } },
        ssr: { name: "ssr", hot: { send: ssrSend } },
      },
      ws: { send: wsSend },
    };
    if (!isViteDevServer(server)) {
      throw new Error("expected ViteDevServer fixture");
    }

    sendFullReload(server);

    expect(clientSend).toHaveBeenCalledWith({ type: "full-reload" });
    expect(ssrSend).toHaveBeenCalledWith({ type: "full-reload" });
    expect(wsSend).not.toHaveBeenCalled();
  });
});
