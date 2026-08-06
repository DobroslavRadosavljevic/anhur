import { describe, expect, it } from "vitest";
import {
  clearIntegrationHandlers,
  createIntegrationConfigEntry,
  defineIntegration,
  getIntegrationHandler,
  registerIntegration,
  runIntegrations,
} from "../../src/integrations";

describe("integrations runtime", () => {
  it("runs defineIntegration onComplete hooks", async () => {
    const calls: string[] = [];
    await runIntegrations(
      [
        defineIntegration({
          id: "custom",
          onComplete: async (ctx) => {
            calls.push(`custom:${ctx.sources.length}`);
          },
        }),
      ],
      {
        rootDir: "/tmp",
        outputDir: "/tmp/out",
        sources: [],
        config: { content: [] },
      },
    );
    expect(calls).toEqual(["custom:0"]);
  });

  it("runs registered handlers for plain { id, ...options } entries", async () => {
    clearIntegrationHandlers();
    const seen: unknown[] = [];
    registerIntegration({
      id: "demo",
      run: async (options) => {
        seen.push(options);
      },
    });

    await runIntegrations([{ id: "demo", greet: "hi" }], {
      rootDir: "/tmp",
      outputDir: "/tmp/out",
      sources: [],
      config: { content: [] },
    });

    expect(seen).toEqual([{ greet: "hi" }]);
    expect(getIntegrationHandler("demo")?.id).toBe("demo");
    clearIntegrationHandlers();
  });

  it("resolves package factories before running their handlers", async () => {
    clearIntegrationHandlers();
    const seen: unknown[] = [];
    registerIntegration({
      id: "demo",
      run: (options) => {
        seen.push(options);
      },
    });

    await runIntegrations(
      [
        createIntegrationConfigEntry<readonly [], "demo">("demo", {
          greet: "hi",
        }),
      ],
      {
        rootDir: "/tmp",
        outputDir: "/tmp/out",
        sources: [],
        config: { content: [] },
      },
    );

    expect(seen).toEqual([{ greet: "hi" }]);
    clearIntegrationHandlers();
  });

  it("fails when an id has no onComplete and no registered handler", async () => {
    clearIntegrationHandlers();
    await expect(
      runIntegrations([{ id: "missing" }], {
        rootDir: "/tmp",
        outputDir: "/tmp/out",
        sources: [],
        config: { content: [] },
      }),
    ).rejects.toThrow(/unknown integration "missing"/);
  });
});
