import { Predicate, Schema } from "effect";
import type { Diagnostic } from "../diagnostics";
import {
  setField,
  type ContentMeta,
  type DocumentFields,
  type DocumentValue,
} from "../document";
import type { BuildMode } from "../plugin/types";
import type { CachedDependency } from "./field-cache.service";
import type { FileSignature } from "./file-signature";
import { findNonPlainData } from "./plain-data";
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

/** A thrown value as data. */
export type WireCause =
  | {
      /** An error: a new `Error` with the same name, message, stack and fields. */
      readonly kind: "error";
      readonly name: string;
      readonly message: string;
      readonly stack: string | undefined;
      /** Own properties of the error (`code`, `line`, …) that are plain data. */
      readonly fields: DocumentFields;
      readonly cause?: WireCause;
    }
  /** Plain data, as it was thrown. */
  | { readonly kind: "data"; readonly value: DocumentValue }
  /** Any other value, as text. */
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

/**
 * A message without what it carries. Code of the project runs in a worker
 * and can post to the same port, so a message is checked before use. The
 * files and results in it are not: that would walk every document again.
 */
const RequestEnvelope = Schema.Struct({
  id: Schema.Number,
  files: Schema.Array(Schema.Unknown),
  dryRun: Schema.Boolean,
  readAt: Schema.Number,
});
const ReplyEnvelope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("done"),
    id: Schema.Number,
    results: Schema.Array(Schema.Unknown),
  }),
]);
const isRequestEnvelope = Schema.is(RequestEnvelope);
const isReplyEnvelope = Schema.is(ReplyEnvelope);

/** True for a message the engine sends to a worker. */
export function isWorkerRequest(input: unknown): input is WorkerRequest {
  return isRequestEnvelope(input);
}

/** True for a message a worker sends to the engine. */
export function isWorkerReply(input: unknown): input is WorkerReply {
  return isReplyEnvelope(input);
}

/**
 * Causes nested deeper than this are left out: a chain can be long, and a
 * cause can point back at itself.
 */
const CAUSE_DEPTH = 8;

/** True for plain data that `postMessage` can copy. */
function isCopyable(value: unknown): value is DocumentValue {
  if (findNonPlainData(value) !== undefined) return false;
  if (!Predicate.isObject(value) && !Array.isArray(value)) return true;
  try {
    // A proxy looks like plain data and still cannot be copied.
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/** Sent on their own, not as fields. */
const ERROR_KEYS: ReadonlySet<string> = new Set([
  "name",
  "message",
  "stack",
  "cause",
]);

/** The own enumerable properties of `value` that can be copied. */
function fieldsOf(value: unknown): DocumentFields {
  const fields: DocumentFields = {};
  if (!Predicate.isObject(value)) return fields;
  const isError = value instanceof Error;
  for (const [key, field] of Object.entries(value)) {
    if (isError && ERROR_KEYS.has(key)) continue;
    if (isCopyable(field)) setField(fields, key, field);
  }
  return fields;
}

function toWireCause(cause: unknown, depth: number): WireCause {
  if (cause instanceof Error) {
    const inner: unknown = cause.cause;
    return {
      kind: "error",
      name: String(cause.name),
      message: String(cause.message),
      stack: Predicate.isString(cause.stack) ? cause.stack : undefined,
      fields: fieldsOf(cause),
      ...(inner === undefined || depth >= CAUSE_DEPTH
        ? {}
        : { cause: toWireCause(inner, depth + 1) }),
    };
  }
  if (isCopyable(cause)) return { kind: "data", value: cause };
  // An object with a part that cannot be copied keeps the rest.
  if (Predicate.isObject(cause))
    return { kind: "data", value: fieldsOf(cause) };
  return { kind: "text", text: String(cause) };
}

/**
 * A diagnostic as data `postMessage` can copy. The cause keeps what can be
 * copied: an error its name, message, stack, own properties (`code`,
 * `line`, …) and its own cause; plain data stays as it is. Never throws.
 */
export function toWireDiagnostic(diagnostic: Diagnostic): WireDiagnostic {
  const { cause, ...rest } = diagnostic;
  if (cause === undefined) return rest;
  try {
    return { ...rest, cause: toWireCause(cause, 0) };
  } catch {
    // A getter or a proxy of the cause threw: the diagnostic still counts.
    return {
      ...rest,
      cause: { kind: "text", text: "(a cause that could not be read)" },
    };
  }
}

function fromWireCause(cause: WireCause): Pick<Diagnostic, "cause"> {
  if (cause.kind === "text") return { cause: cause.text };
  if (cause.kind === "data") return { cause: cause.value };
  const error =
    cause.cause === undefined
      ? new Error(cause.message)
      : new Error(cause.message, fromWireCause(cause.cause));
  error.name = cause.name;
  if (cause.stack !== undefined) error.stack = cause.stack;
  for (const [key, value] of Object.entries(cause.fields)) {
    // Not an assignment: a field named `__proto__` must stay a field.
    Object.defineProperty(error, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { cause: error };
}

export function fromWireDiagnostic(diagnostic: WireDiagnostic): Diagnostic {
  const { cause, ...rest } = diagnostic;
  if (cause === undefined) return rest;
  return { ...rest, ...fromWireCause(cause) };
}
