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
