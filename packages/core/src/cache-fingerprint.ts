import { createHash } from "node:crypto";

/**
 * JSON-serializable snapshot of compile options, including unified plugin
 * functions. Used as the persist-cache input so swapping plugins or their
 * tuple options invalidates MDX/Markdown disk cache.
 *
 * Prefer `[plugin, options]` tuples: a factory call `plugin(options)` returns
 * a transformer whose `toString()` does not include closed-over option values.
 */
export function fingerprintCacheValue(value: unknown): unknown {
  return walk(value, new WeakSet<object>());
}

function functionFingerprint(fn: { name: string; toString(): string }): string {
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

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }
  if (type === "bigint") return `${value}n`;
  if (type === "symbol") return value.toString();
  if (type === "function") {
    return functionFingerprint(value as { name: string; toString(): string });
  }
  if (type !== "object") return String(value);

  const object = value as object;
  if (seen.has(object)) return "[Circular]";
  seen.add(object);

  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => walk(item, seen));

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = walk(record[key], seen);
  }
  return out;
}
