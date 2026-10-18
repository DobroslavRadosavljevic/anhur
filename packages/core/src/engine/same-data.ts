import { isPlainObject, type DocumentValue } from "../document";
import { MAX_DEPTH } from "./plain-data";

/**
 * Containers compared before the compared pairs are remembered. Nearly
 * every document is smaller, so nothing is remembered for it.
 */
const FREE_CONTAINERS = 100_000;

type Comparison = {
  /** Containers that can still be compared without a record. */
  free: number;
  /** Pairs compared after that, by the left container. */
  pairs: Map<object, Set<object>> | undefined;
};

function same(
  left: DocumentValue,
  right: DocumentValue,
  depth: number,
  state: Comparison,
): boolean {
  // Also the same container, `NaN` and `NaN`, and not `0` and `-0`.
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (depth > MAX_DEPTH) return false;
  if (state.free > 0) state.free -= 1;
  else {
    state.pairs ??= new Map();
    const rights = state.pairs.get(left);
    // A pair seen before is the same unless a difference is found
    // elsewhere, and the first difference ends the whole comparison.
    if (rights?.has(right)) return true;
    if (rights) rights.add(right);
    else state.pairs.set(left, new Set([right]));
  }

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    const items: readonly DocumentValue[] = left;
    const others: readonly DocumentValue[] = right;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const other = others[index];
      if (item === undefined && other === undefined) {
        // A hole is not `undefined`.
        if (index in items !== index in others) return false;
      } else if (!same(item, other, depth + 1, state)) return false;
    }
    return true;
  }
  if (left instanceof Date) {
    // Invalid dates are the same.
    return right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (left instanceof Map) {
    if (!(right instanceof Map) || left.size !== right.size) return false;
    const others = right.entries();
    for (const [key, item] of left) {
      const other = others.next();
      if (other.done === true) return false;
      const [otherKey, otherItem] = other.value;
      if (!same(key, otherKey, depth + 1, state)) return false;
      if (!same(item, otherItem, depth + 1, state)) return false;
    }
    return true;
  }
  if (left instanceof Set) {
    if (!(right instanceof Set) || left.size !== right.size) return false;
    const others = right.values();
    for (const item of left) {
      const other = others.next();
      if (other.done === true) return false;
      if (!same(item, other.value, depth + 1, state)) return false;
    }
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  const otherKeys = Object.keys(right);
  if (keys.length !== otherKeys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (key !== otherKeys[index]) return false;
    if (!same(left[key], right[key], depth + 1, state)) return false;
  }
  return true;
}

/**
 * True when two values of document data are the same data: both give the
 * same text in a generated module. The engine uses it to keep the document
 * object of the last build when a transform or `prepare` makes equal data
 * again, so every later stage still knows the document.
 *
 * Strict on purpose: `false` for equal data only costs work, `true` for
 * different data would lose a change. Object keys and `Map` / `Set`
 * entries must have the same order, `-0` is not `0`, a hole is not
 * `undefined`. `NaN` is `NaN`, and all invalid dates are the same. An
 * object used in two places counts by its value.
 *
 * Always ends, also on cyclic data: data nested deeper than a document may
 * be ({@link MAX_DEPTH}) is never the same, and in very large data a pair
 * of containers is compared once.
 */
export function sameData(left: DocumentValue, right: DocumentValue): boolean {
  return same(left, right, 0, { free: FREE_CONTAINERS, pairs: undefined });
}
