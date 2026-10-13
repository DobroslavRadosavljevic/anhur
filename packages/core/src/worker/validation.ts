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
  isWorkerRequest,
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

/** Why something failed: never empty. */
function reasonOf(cause: unknown): string {
  const text = messageOf(cause).trim();
  if (text !== "") return text;
  return cause instanceof Error && cause.name !== ""
    ? cause.name
    : "an error without a message";
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
      message: `the config did not load in a worker: ${reasonOf(cause)}`,
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
  // The engine starts a worker for one build and stops it after, so this
  // is the state of one build: every batch shares the hashes, the stats
  // and the checked assets, and the next build starts with none of them.
  const session: FieldSession = {
    project,
    publicBase: setup.publicBase,
    assetRoots: setup.assetRoots,
    hashes: new Map<string, AssetHashEntry>(),
    stats: createSignatureMemo(),
    emitted: new Map(),
  };

  const validate = async (request: WorkerRequest): Promise<WireResult[]> => {
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
    if (!isWorkerRequest(input)) return;
    const request = input;
    validate(request).then(
      (results) => {
        try {
          reply({ type: "done", id: request.id, results });
        } catch (cause) {
          // A result that `postMessage` cannot copy (a proxy, for one).
          reply({
            type: "failed",
            message: `a worker could not send its results: ${reasonOf(cause)}`,
          });
        }
      },
      (cause: unknown) => {
        reply({
          type: "failed",
          message: `a worker failed: ${reasonOf(cause)}`,
        });
      },
    );
  });
  // A request that cannot be read is never answered: say so now.
  port.on("messageerror", (cause: unknown) => {
    reply({
      type: "failed",
      message: `a worker could not read a request: ${reasonOf(cause)}`,
    });
  });
  reply({ type: "ready" });
}

await main();
