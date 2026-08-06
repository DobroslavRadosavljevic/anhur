import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { canonicalizePath } from "@anhur/core";
import {
  IMPORT_ID,
  invalidateGeneratedModules,
  sendFullReload,
  syncViteWatchRoots,
  type DevWatchState,
} from "../../src/dev-watch";

describe("dev-watch helpers", () => {
  it("exposes IMPORT_ID", () => {
    expect(IMPORT_ID).toBe("anhur/generated");
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
    } as unknown as ViteDevServer;

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

  it("invalidateGeneratedModules invalidates matching module graph entries", () => {
    const invalidateModule = vi.fn();
    const mod = { id: IMPORT_ID };
    const server = {
      moduleGraph: {
        getModuleById: (id: string) => (id === IMPORT_ID ? mod : undefined),
        urlToModuleMap: new Map([
          ["anhur/generated", mod],
          ["/src/app.tsx", { id: "app" }],
        ]),
        invalidateModule,
      },
    } as unknown as ViteDevServer;

    invalidateGeneratedModules(server);
    expect(invalidateModule).toHaveBeenCalled();
  });

  it("sendFullReload sends a full-reload websocket message", () => {
    const send = vi.fn();
    const server = { ws: { send } } as unknown as ViteDevServer;
    sendFullReload(server);
    expect(send).toHaveBeenCalledWith({ type: "full-reload" });
  });
});
