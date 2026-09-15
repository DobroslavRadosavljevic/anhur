import { createHash } from "node:crypto";
import { Predicate } from "effect";
import {
  isDocumentFields,
  type DocumentFields,
  type DocumentNode,
} from "./document-fields";

export type CacheFingerprint = DocumentNode | string;

type NamedFunction = {
  readonly name: string;
  toString(): string;
};

function isNamedFunction(value: unknown): value is NamedFunction {
  return Predicate.isFunction(value);
}

function isBigIntValue(value: unknown): value is bigint {
  return typeof value === "bigint";
}

function isSymbolValue(value: unknown): value is symbol {
  return typeof value === "symbol";
}

/**
 * JSON-serializable snapshot of compile options, including unified plugin
 * functions. Used as the persist-cache input so swapping plugins or their
 * tuple options invalidates MDX/Markdown disk cache.
 *
 * Prefer `[plugin, options]` tuples: a factory call `plugin(options)` returns
 * a transformer whose `toString()` does not include closed-over option values.
 */
export function fingerprintCacheValue(value: unknown): CacheFingerprint {
  return walk(value, new WeakSet<object>());
}

function functionFingerprint(fn: NamedFunction): string {
  let src = "";
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    src = "";
  }
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 16);
  const name = fn.name.length > 0 ? fn.name : "anonymous";
  return `fn:${name}:${src.length}:${hash}`;
}

function walk(value: unknown, seen: WeakSet<object>): CacheFingerprint {
  if (value === null || value === undefined) return value;
  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }
  if (isBigIntValue(value)) return `${value}n`;
  if (isSymbolValue(value)) return value.toString();
  if (isNamedFunction(value)) {
    return functionFingerprint(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => walk(item, seen));
  }
  if (!Predicate.isObject(value)) return String(value);

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Date) return value.toISOString();

  if (!isDocumentFields(value)) return String(value);
  const out: DocumentFields = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = walk(value[key], seen);
  }
  return out;
}
