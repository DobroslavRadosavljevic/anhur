import { Predicate } from "effect";
import { isPlainObject, type DocumentValue } from "../document";
import { findNonPlainData } from "./plain-data";

/**
 * JSON encoding for cached field values that keeps `Date`, `Map`, `Set`,
 * `BigInt`, `undefined` and non-finite numbers. Tagged values are objects
 * with a single `"\u0000"` key, which plain content never uses.
 */
type Encoded =
  | string
  | number
  | boolean
  | null
  | Encoded[]
  | { [key: string]: Encoded };

const TAG = "\u0000";

function tagged(kind: string, payload: Encoded): Encoded {
  return { [TAG]: [kind, payload] };
}

/** Set an own property, also for `__proto__` (plain assignment would change the prototype). */
function setOwn<T>(target: { [key: string]: T }, key: string, item: T): void {
  Object.defineProperty(target, key, {
    value: item,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** True when {@link encodeCacheValue} / {@link decodeCacheValue} round-trip the value exactly. */
export function canCache(value: DocumentValue): boolean {
  return findNonPlainData(value) === undefined;
}

export function encodeCacheValue(value: DocumentValue): Encoded {
  if (value === undefined) return tagged("u", null);
  if (value === null) return null;
  if (Predicate.isString(value) || Predicate.isBoolean(value)) return value;
  if (Predicate.isNumber(value)) {
    if (Object.is(value, -0)) return tagged("n", "-0");
    return Number.isFinite(value) ? value : tagged("n", String(value));
  }
  if (Predicate.isBigInt(value)) return tagged("b", value.toString());
  if (value instanceof Date) return tagged("d", value.getTime());
  if (Array.isArray(value)) {
    const items: readonly DocumentValue[] = value;
    // Array.from visits holes (as undefined); map would keep them and JSON would write null.
    return Array.from(items, (item) => encodeCacheValue(item));
  }
  if (value instanceof Map) {
    return tagged(
      "m",
      [...value.entries()].map(([key, item]) => [
        encodeCacheValue(key),
        encodeCacheValue(item),
      ]),
    );
  }
  if (value instanceof Set) {
    return tagged(
      "s",
      [...value.values()].map((item) => encodeCacheValue(item)),
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    // An object that itself uses the tag key is wrapped so it is never read back as a tagged value.
    if (entries.some(([key]) => key === TAG)) {
      return tagged(
        "o",
        entries.map(([key, item]) => [key, encodeCacheValue(item)]),
      );
    }
    const out: { [key: string]: Encoded } = {};
    for (const [key, item] of entries) {
      setOwn(out, key, encodeCacheValue(item));
    }
    return out;
  }
  // Not plain data: canCache() keeps such values out of the cache.
  return null;
}

function isTagged<T>(value: T): value is T & { [TAG]: [string, Encoded] } {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value[TAG])
  );
}

export function decodeCacheValue(value: unknown): DocumentValue {
  if (value === null) return null;
  if (
    Predicate.isString(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isNumber(value)
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => decodeCacheValue(item));
  if (isTagged(value)) {
    const [kind, payload] = value[TAG];
    switch (kind) {
      case "u":
        return undefined;
      case "n":
        return payload === "-0" ? -0 : Number(payload);
      case "b":
        return BigInt(String(payload));
      case "d":
        return new Date(Number(payload));
      case "m":
        return new Map(
          (Array.isArray(payload) ? payload : []).map((entry) => {
            const pair = Array.isArray(entry) ? entry : [];
            return [decodeCacheValue(pair[0]), decodeCacheValue(pair[1])];
          }),
        );
      case "s":
        return new Set(
          (Array.isArray(payload) ? payload : []).map((item) =>
            decodeCacheValue(item),
          ),
        );
      case "o": {
        const out: { [key: string]: DocumentValue } = {};
        for (const entry of Array.isArray(payload) ? payload : []) {
          const pair = Array.isArray(entry) ? entry : [];
          if (Predicate.isString(pair[0])) {
            setOwn(out, pair[0], decodeCacheValue(pair[1]));
          }
        }
        return out;
      }
      default:
        return undefined;
    }
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: DocumentValue } = {};
    for (const [key, item] of Object.entries(value)) {
      setOwn(out, key, decodeCacheValue(item));
    }
    return out;
  }
  return undefined;
}
