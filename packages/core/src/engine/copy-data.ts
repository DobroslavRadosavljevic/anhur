import {
  isPlainObject,
  setField,
  type DocumentFields,
  type DocumentValue,
} from "../document";

/** Deepest nesting copied here; deeper values go to `structuredClone`. */
const MAX_DEPTH = 200;

/** Thrown inside {@link copy} for values it leaves to `structuredClone`. */
const tooDeep = Symbol("too-deep");

function copy(
  value: DocumentValue,
  depth: number,
  seen: Map<object, DocumentValue>,
): DocumentValue {
  if (value === null || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (depth > MAX_DEPTH) throw tooDeep;
  if (Array.isArray(value)) {
    const items: readonly DocumentValue[] = value;
    const out: DocumentValue[] = [];
    seen.set(value, out);
    // Holes stay holes, as with `structuredClone`.
    out.length = items.length;
    for (let index = 0; index < items.length; index += 1) {
      if (index in items) out[index] = copy(items[index], depth + 1, seen);
    }
    return out;
  }
  if (value instanceof Date) {
    const out = new Date(value.getTime());
    seen.set(value, out);
    return out;
  }
  if (value instanceof Map) {
    const out = new Map<DocumentValue, DocumentValue>();
    seen.set(value, out);
    for (const [key, item] of value) {
      out.set(copy(key, depth + 1, seen), copy(item, depth + 1, seen));
    }
    return out;
  }
  if (value instanceof Set) {
    const out = new Set<DocumentValue>();
    seen.set(value, out);
    for (const item of value) out.add(copy(item, depth + 1, seen));
    return out;
  }
  if (isPlainObject(value)) {
    const out: DocumentFields = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
      setField(out, key, copy(value[key], depth + 1, seen));
    }
    return out;
  }
  throw tooDeep;
}

/**
 * A deep, unfrozen copy of document data, like `structuredClone` but
 * without copying strings (they cannot change): a document body is shared
 * with the original instead of written out again. Shared and cyclic
 * containers keep their shape. Anything this does not know (and data
 * nested very deeply) is left to `structuredClone`.
 */
export function copyData<T extends DocumentValue>(value: T): T {
  try {
    // SAFETY: `copy` returns a value of the same kind as its argument.
    return copy(value, 0, new Map()) as T;
  } catch (cause) {
    if (cause === tooDeep) return structuredClone(value);
    throw cause;
  }
}
