import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Layer, ManagedRuntime } from "effect";
import { parentPort, workerData } from "node:worker_threads";
import { messageOf } from "../diagnostics";
import { Collector, type StaleFile } from "../engine/collector.service";
import { ConfigLoader } from "../engine/config-loader.service";
import { FieldCache } from "../engine/field-cache.service";
import type { AssetHashEntry, FieldSession } from "../engine/field-context";
import { createSignatureMemo } from "../engine/file-signature";
import type { ResolvedProject } from "../engine/resolve";
import type { SourceFile } from "../engine/types";
import {
  toWireDiagnostic,
  type WireFile,
  type WireResult,
  type WorkerReply,
  type WorkerRequest,
  type WorkerSetup,
} from "../engine/validation-wire";

/**
 * Validation worker: loads the project from its config file, then loads,
 * compiles and validates the files the engine sends, with the same code
 * the engine runs in its own thread.
 */
const WorkerLive = Collector.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ConfigLoader.layer, FieldCache.layer)),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

function isRequest(value: unknown): value is WorkerRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "number" &&
    "files" in value &&
    Array.isArray(value.files)
  );
}

function sourceFile(project: ResolvedProject, file: WireFile): SourceFile {
  const source = project.sources.find((entry) => entry.name === file.source);
  if (!source) {
    throw new Error(`The worker's config has no source "${file.source}".`);
  }
  return {
    source,
    absPath: file.absPath,
    id: file.id,
    locale: file.locale,
    meta: Object.freeze({ ...file.meta }),
  };
}

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const reply = (message: WorkerReply): void => {
    port.postMessage(message);
  };
  // SAFETY: the engine starts this module with a `WorkerSetup` as worker data.
  const setup = workerData as WorkerSetup;
  const runtime = ManagedRuntime.make(WorkerLive);
  let project: ResolvedProject;
  try {
    const loaded = await runtime.runPromise(
      ConfigLoader.use((loader) =>
        loader.load({
          rootDir: setup.rootDir,
          configPath: setup.configPath,
          mode: setup.mode,
        }),
      ),
    );
    project = loaded.project;
  } catch (cause) {
    reply({
      type: "failed",
      message: `the config did not load in a worker: ${messageOf(cause)}`,
    });
    return;
  }
  if (project.fingerprint !== setup.fingerprint) {
    reply({
      type: "failed",
      message: "the config loaded in a worker is not the one being built",
    });
    return;
  }
  /** Asset hashes this worker computed, for the files it meets again. */
  const hashes = new Map<string, AssetHashEntry>();

  const validate = async (request: WorkerRequest): Promise<WireResult[]> => {
    const session: FieldSession = {
      project,
      publicBase: setup.publicBase,
      assetRoots: setup.assetRoots,
      hashes,
      stats: createSignatureMemo(),
      emitted: new Map(),
    };
    const stale: StaleFile[] = request.files.map((file) => ({
      file: sourceFile(project, file),
      raw: file.raw,
      hash: file.hash,
      signature: file.signature,
    }));
    const results = await runtime.runPromise(
      Collector.use((collector) =>
        collector.validateStale(
          project,
          stale,
          session,
          { dryRun: request.dryRun },
          request.readAt,
        ),
      ),
    );
    return results.map((result): WireResult =>
      result.ok
        ? {
            ok: true,
            hash: result.document.hash,
            draft: result.document.draft,
            data: result.document.data,
            effects: result.document.effects,
            warnings: result.warnings,
            dependencies: result.dependencies,
            storeKey: result.storeKey,
          }
        : { ok: false, diagnostics: result.diagnostics.map(toWireDiagnostic) },
    );
  };

  port.on("message", (input: unknown) => {
    if (!isRequest(input)) return;
    const request = input;
    validate(request).then(
      (results) => {
        reply({ type: "done", id: request.id, results });
      },
      (cause: unknown) => {
        reply({
          type: "failed",
          message: `a worker failed: ${messageOf(cause)}`,
        });
      },
    );
  });
  reply({ type: "ready" });
}

await main();
