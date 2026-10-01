import { createHash } from "node:crypto";
import { Predicate } from "effect";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function functionKey(value: Function): string {
  let source = "";
  try {
    source = Function.prototype.toString.call(value);
  } catch {
    source = "";
  }
  const name = value.name.length > 0 ? value.name : "anonymous";
  return `f:${name}:${sha256(source).slice(0, 16)}`;
}

/** `Symbol.iterator` & co.: the same in every process, keyed by name. */
const WELL_KNOWN_SYMBOLS = new Map<symbol, string>();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  const value: unknown = Reflect.get(Symbol, name);
  if (Predicate.isSymbol(value)) WELL_KNOWN_SYMBOLS.set(value, name);
}

/**
 * Identity of unique symbols in this process (two `Symbol("x")` differ).
 * Entries are never removed, so the size is the next id.
 */
const symbolIds = new Map<symbol, number>();

function symbolKey(value: symbol): string {
  const registered = Symbol.keyFor(value);
  if (registered !== undefined) return `sf:${JSON.stringify(registered)}`;
  const known = WELL_KNOWN_SYMBOLS.get(value);
  if (known !== undefined) return `sw:${known}`;
  let id = symbolIds.get(value);
  if (id === undefined) {
    id = symbolIds.size + 1;
    symbolIds.set(value, id);
  }
  return `s:${JSON.stringify(value.description ?? "")}#${id}`;
}

function bytesKey(name: string, bytes: Uint8Array): string {
  return `${name}:${createHash("sha256").update(bytes).digest("hex")}`;
}

function constructorName(value: unknown): string {
  if (!Predicate.isObjectOrArray(value)) return "";
  const proto: object | null = Object.getPrototypeOf(value);
  if (!proto || proto === Object.prototype) return "";
  return "constructor" in proto && Predicate.isFunction(proto.constructor)
    ? proto.constructor.name
    : "";
}

/** `String(value)` of a class instance when it says more than `[object X]`. */
function instanceText(value: unknown): string {
  let text: string;
  try {
    text = String(value);
  } catch {
    return "";
  }
  return /^\[object [^\]]*\]$/.test(text) ? "" : `|${JSON.stringify(text)}`;
}

type State = {
  /** Objects on the current path (true cycles). */
  readonly active: Set<object>;
  /** Finished objects: shared references are fingerprinted once. */
  readonly memo: Map<object, string>;
};

function canonical(value: unknown, state: State): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Predicate.isString(value)) return JSON.stringify(value);
  if (Predicate.isNumber(value)) {
    return Object.is(value, -0) ? "n:-0" : `n:${String(value)}`;
  }
  if (Predicate.isBoolean(value)) return value ? "true" : "false";
  if (Predicate.isBigInt(value)) return `b:${value.toString()}`;
  if (Predicate.isSymbol(value)) return symbolKey(value);
  if (Predicate.isFunction(value)) return functionKey(value);
  if (!Predicate.isObjectOrArray(value)) return `?:${String(value)}`;
  const memo = state.memo.get(value);
  if (memo !== undefined) return memo;
  if (state.active.has(value)) return "[Circular]";
  state.active.add(value);
  try {
    const raw = objectKey(value, state);
    // Long keys are replaced by their hash, so shared sub-values do not
    // make the key grow exponentially.
    const key = raw.length > 256 ? `h:${sha256(raw)}` : raw;
    state.memo.set(value, key);
    return key;
  } finally {
    state.active.delete(value);
  }
}

function objectKey(value: unknown, state: State): string {
  if (!Predicate.isObjectOrArray(value)) return `?:${String(value)}`;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map((item) => canonical(item, state)).join(",")}]`;
  }
  if (value instanceof Date) {
    return `d:${Number.isNaN(value.getTime()) ? "NaN" : value.toISOString()}`;
  }
  if (value instanceof RegExp) {
    return `r:/${value.source}/${value.flags}|${value.lastIndex}`;
  }
  if (value instanceof URL) return `URL:${JSON.stringify(value.href)}`;
  if (ArrayBuffer.isView(value)) {
    return bytesKey(
      constructorName(value),
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    return bytesKey(constructorName(value), new Uint8Array(value));
  }
  // Map / Set iteration order is observable, so it is part of the key.
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([key, item]) => `${canonical(key, state)}=>${canonical(item, state)}`,
    );
    return `${constructorName(value)}{${entries.join(",")}}`;
  }
  if (value instanceof Set) {
    const items = [...value.values()].map((item) => canonical(item, state));
    return `${constructorName(value)}{${items.join(",")}}`;
  }
  const name = constructorName(value);
  const keys = Object.keys(value).sort();
  const body = keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical(Reflect.getOwnPropertyDescriptor(value, key)?.value, state)}`,
    )
    .join(",");
  const text = name === "" ? "" : instanceText(value);
  return `${name}{${body}}${text}`;
}

/**
 * Stable SHA-256 fingerprint of any value, for cache keys. Covers arrays,
 * RegExp, URL, Map / Set (in iteration order), Date, typed arrays and
 * buffers, class instances (constructor name, own fields and `String()`
 * when it is informative), symbols (registered and well-known ones by
 * name, others by identity in this process) and functions (by source).
 * Shared references are fingerprinted once; only true cycles collapse to
 * `[Circular]`.
 *
 * Closures and private fields cannot be inspected: `plugin({ a: 1 })` and
 * `plugin({ a: 2 })` return functions with the same source. Pass plugins as
 * `[plugin, options]` tuples so their options are part of the key.
 */
export function fingerprint(value: unknown): string {
  return sha256(canonical(value, { active: new Set(), memo: new Map() }));
}
