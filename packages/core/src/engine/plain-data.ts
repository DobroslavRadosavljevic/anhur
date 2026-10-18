import { Predicate } from "effect";
import { isPlainObject, type FieldPath } from "../document";

/** Where and why a document value is not plain data. */
export type PlainDataProblem = {
  readonly message: string;
  readonly fieldPath: FieldPath;
};

/** Deepest nesting accepted in a document. */
export const MAX_DEPTH = 1000;

function describe(value: unknown): string {
  const proto: object | null = Predicate.isObject(value)
    ? Object.getPrototypeOf(value)
    : null;
  const name =
    proto && "constructor" in proto && Predicate.isFunction(proto.constructor)
      ? proto.constructor.name
      : "object";
  return `a ${name || "class"} instance`;
}

/** Nesting the quick check follows before it leaves the value to the full walk. */
const QUICK_DEPTH = 64;
/** Values the quick check looks at before it gives up (a cycle would never end). */
const QUICK_BUDGET = 200_000;

type Budget = { left: number };

/**
 * True when `value` is certainly plain data: plain objects, arrays, `Map`,
 * `Set`, `Date` and primitives, at most {@link QUICK_DEPTH} levels deep
 * and within the budget. `false` means "look closer", not "invalid":
 * cycles and very large values end here and get the full walk.
 */
function isClearlyPlain(
  value: unknown,
  depth: number,
  budget: Budget,
): boolean {
  if (value === null || value === undefined) return true;
  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isBigInt(value)
  ) {
    return true;
  }
  if (!Predicate.isObject(value) && !Array.isArray(value)) return false;
  if (value instanceof Date) return true;
  budget.left -= 1;
  if (depth >= QUICK_DEPTH || budget.left < 0) return false;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    for (let index = 0; index < items.length; index += 1) {
      if (!isClearlyPlain(items[index], depth + 1, budget)) return false;
    }
    return true;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (!isClearlyPlain(value[key], depth + 1, budget)) return false;
    }
    return true;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (!isClearlyPlain(key, depth + 1, budget)) return false;
      if (!isClearlyPlain(item, depth + 1, budget)) return false;
    }
    return true;
  }
  if (value instanceof Set) {
    for (const item of value) {
      if (!isClearlyPlain(item, depth + 1, budget)) return false;
    }
    return true;
  }
  return false;
}

type Frame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly path: FieldPath;
    }
  | { readonly kind: "exit"; readonly value: object };

/**
 * First value that cannot be cached, cloned and written into a generated
 * module: functions, symbols, class instances (`URL`, custom classes),
 * cycles, and nesting deeper than {@link MAX_DEPTH}. JSON-like data plus
 * `Date`, `Map`, `Set`, `bigint` and `undefined` is plain data.
 * Iterative, so very deep input cannot overflow the stack.
 */
export function findNonPlainData(
  value: unknown,
  basePath: FieldPath = [],
): PlainDataProblem | undefined {
  // Nearly every value is a small tree of plain data: no need to track
  // paths, cycles and shared objects for it.
  if (isClearlyPlain(value, 0, { left: QUICK_BUDGET })) return undefined;
  const active = new Set<object>();
  // Shared (non-cyclic) objects are checked once.
  const done = new Set<object>();
  const stack: Frame[] = [{ kind: "enter", value, path: basePath }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      done.add(frame.value);
      continue;
    }
    const { value: current, path } = frame;
    if (
      current === null ||
      current === undefined ||
      Predicate.isString(current) ||
      Predicate.isNumber(current) ||
      Predicate.isBoolean(current) ||
      Predicate.isBigInt(current)
    ) {
      continue;
    }
    if (Predicate.isFunction(current)) {
      return { message: "is a function, not data", fieldPath: path };
    }
    if (Predicate.isSymbol(current)) {
      return { message: "is a symbol, not data", fieldPath: path };
    }
    // Predicate.isObject is false for arrays.
    if (!Predicate.isObject(current) && !Array.isArray(current)) continue;
    if (current instanceof Date || done.has(current)) continue;
    if (path.length - basePath.length > MAX_DEPTH) {
      return {
        message: `is nested more than ${MAX_DEPTH} levels deep`,
        fieldPath: path,
      };
    }
    if (active.has(current)) {
      return { message: "contains a circular reference", fieldPath: path };
    }
    const children: [string | number, unknown][] = [];
    if (Array.isArray(current)) {
      const items: readonly unknown[] = current;
      for (let index = 0; index < items.length; index += 1) {
        children.push([index, items[index]]);
      }
    } else if (current instanceof Map) {
      let index = 0;
      for (const [key, item] of current) {
        children.push([index, key], [index, item]);
        index += 1;
      }
    } else if (current instanceof Set) {
      let index = 0;
      for (const item of current) {
        children.push([index, item]);
        index += 1;
      }
    } else if (isPlainObject(current)) {
      for (const key of Object.keys(current)) {
        children.push([key, current[key]]);
      }
    } else {
      return {
        message: `is ${describe(current)}; schemas and transforms must return plain data (strings, numbers, booleans, arrays, objects, Date, Map, Set)`,
        fieldPath: path,
      };
    }
    active.add(current);
    stack.push({ kind: "exit", value: current });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const [key, child] = children[index]!;
      stack.push({ kind: "enter", value: child, path: [...path, key] });
    }
  }
  return undefined;
}
