import type { Diagnostic } from "../diagnostics";
import type { ContentMeta, DocumentFields } from "../document";
import type { BuildMode } from "../plugin/types";
import type { CachedDependency } from "./field-cache.service";
import type { FileSignature } from "./file-signature";
import type { DocumentEffects } from "./types";

/**
 * Messages between the engine and its validation workers. Everything here
 * is plain data that `postMessage` can copy.
 */

/** What a worker needs to load the same project as the engine. */
export type WorkerSetup = {
  /** Directory of the config file. */
  readonly rootDir: string;
  /** Absolute path of the config file. */
  readonly configPath: string;
  readonly mode: BuildMode;
  /** Fingerprint of the engine's project; the worker's must be the same. */
  readonly fingerprint: string;
  readonly publicBase: string | undefined;
  readonly assetRoots: readonly string[];
};

/** A file to validate. `source` is the name of its collection / singleton. */
export type WireFile = {
  readonly source: string;
  readonly absPath: string;
  readonly id: string;
  readonly locale: string | undefined;
  readonly meta: ContentMeta;
  readonly raw: string | undefined;
  readonly hash: string | undefined;
  readonly signature: FileSignature | undefined;
};

/** A thrown value as data: errors keep their name, message and stack. */
export type WireCause =
  | {
      readonly kind: "error";
      readonly name: string;
      readonly message: string;
      readonly stack: string | undefined;
    }
  | { readonly kind: "text"; readonly text: string };

export type WireDiagnostic = Omit<Diagnostic, "cause"> & {
  readonly cause?: WireCause;
};

export type WireResult =
  | {
      readonly ok: true;
      readonly hash: string;
      readonly draft: boolean;
      readonly data: DocumentFields;
      readonly effects: DocumentEffects;
      readonly warnings: readonly string[];
      readonly dependencies: readonly CachedDependency[];
      readonly storeKey: string | undefined;
    }
  | { readonly ok: false; readonly diagnostics: readonly WireDiagnostic[] };

export type WorkerRequest = {
  readonly id: number;
  readonly files: readonly WireFile[];
  readonly dryRun: boolean;
  readonly readAt: number;
};

export type WorkerReply =
  /** The project is loaded; requests can be sent. */
  | { readonly type: "ready" }
  /** The worker cannot do the work (it then exits). */
  | { readonly type: "failed"; readonly message: string }
  | {
      readonly type: "done";
      readonly id: number;
      readonly results: readonly WireResult[];
    };

export function toWireDiagnostic(diagnostic: Diagnostic): WireDiagnostic {
  const { cause, ...rest } = diagnostic;
  if (cause === undefined) return rest;
  return {
    ...rest,
    cause:
      cause instanceof Error
        ? {
            kind: "error",
            name: cause.name,
            message: cause.message,
            stack: cause.stack,
          }
        : { kind: "text", text: String(cause) },
  };
}

export function fromWireDiagnostic(diagnostic: WireDiagnostic): Diagnostic {
  const { cause, ...rest } = diagnostic;
  if (cause === undefined) return rest;
  if (cause.kind === "text") return { ...rest, cause: cause.text };
  const error = new Error(cause.message);
  error.name = cause.name;
  if (cause.stack !== undefined) error.stack = cause.stack;
  return { ...rest, cause: error };
}
