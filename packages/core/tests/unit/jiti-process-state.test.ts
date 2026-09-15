import { createJiti } from "jiti";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearIntegrationHandlers,
  getIntegrationHandler,
  runIntegrations,
} from "../../src/integrations";
import { getDocumentMeta, withDocumentMeta } from "../../src/document-meta";
import {
  getBuildContext,
  withBuildContext,
  type BuildContext,
} from "../../src/build-context";
import { isSkippedSignal } from "../../src/skip";

// Keep under this package so jiti can resolve workspace `@anhur/*`.
const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  clearIntegrationHandlers();
});

async function createScratch(prefix: string) {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, prefix));
  scratchRoots.push(root);
  return root;
}

/**
 * Force jiti to transpile `@anhur/*` (empty nativeModules) so config load uses
 * duplicate module instances — the same failure mode as workspace realpaths.
 */
function createIsolatingJiti() {
  return createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: true,
    fsCache: false,
    nativeModules: [],
  });
}

describe("jiti host process state sharing", () => {
  it("keeps integration registration visible to the host after a jiti import", async () => {
    clearIntegrationHandlers();
    expect(getIntegrationHandler("probe")).toBeUndefined();

    const root = await createScratch("jiti-register-");
    const registerPath = path.join(root, "register-probe.ts");
    await writeFile(
      registerPath,
      `import { registerIntegration } from "@anhur/core";

registerIntegration({
  id: "probe",
  run: async () => {},
});
`,
    );

    const jiti = createIsolatingJiti();
    await jiti.import(registerPath);

    // Host map must see the registration from the jiti-evaluated package.
    expect(getIntegrationHandler("probe")?.id).toBe("probe");

    await expect(
      runIntegrations([{ id: "probe" }], {
        rootDir: root,
        outputDir: path.join(root, "out"),
        sources: [],
        config: { content: [] },
      }),
    ).resolves.toBeUndefined();
  });

  it("shares document-meta ALS across jiti-evaluated helpers", async () => {
    const root = await createScratch("jiti-meta-");
    const helperPath = path.join(root, "read-meta.ts");
    await writeFile(
      helperPath,
      `import { getDocumentMeta } from "@anhur/core";
export function readId() {
  return getDocumentMeta().id;
}
`,
    );

    const jiti = createIsolatingJiti();
    const mod = (await jiti.import(helperPath)) as {
      readId: () => string | undefined;
    };

    const id = await withDocumentMeta(
      {
        path: "/tmp/doc.md",
        id: "shared-across-jiti",
        sourceName: "posts",
        config: { content: [] },
      },
      async () => mod.readId(),
    );

    expect(id).toBe("shared-across-jiti");
    expect(() => getDocumentMeta()).toThrow(/unavailable/);
  });

  it("shares build-context ALS across jiti-evaluated helpers", async () => {
    const root = await createScratch("jiti-build-");
    const helperPath = path.join(root, "read-build.ts");
    await writeFile(
      helperPath,
      `import { getBuildContext } from "@anhur/core";
export function readRoot() {
  return getBuildContext().rootDir;
}
`,
    );

    const jiti = createIsolatingJiti();
    const mod = (await jiti.import(helperPath)) as {
      readRoot: () => string;
    };

    const fakeCtx = {
      rootDir: "/tmp/shared-build-root",
      configDir: "/tmp",
      config: { content: [] },
      processors: [],
      cache: new Map(),
      persistCache: undefined,
      assets: undefined,
      getProcessor: () => undefined,
      getEmittedAssets: () => [],
      getEmittedAssetSources: () => [],
      emitAsset: async () => {
        throw new Error("unused");
      },
    } satisfies BuildContext;

    const rootDir = await withBuildContext(fakeCtx, async () => mod.readRoot());
    expect(rootDir).toBe("/tmp/shared-build-root");
    expect(() => getBuildContext()).toThrow(/unavailable/);
  });

  it("shares Symbol.for skip identity across module copies", async () => {
    const root = await createScratch("jiti-skip-");
    const helperPath = path.join(root, "make-skip.ts");
    await writeFile(
      helperPath,
      `import { createSkippedSignal } from "@anhur/core";
export function makeSkip() {
  return createSkippedSignal("from-jiti");
}
`,
    );

    const jiti = createIsolatingJiti();
    const mod = (await jiti.import(helperPath)) as {
      makeSkip: () => unknown;
    };
    expect(isSkippedSignal(mod.makeSkip())).toBe(true);
  });
});
