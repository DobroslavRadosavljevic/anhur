import { Predicate } from "effect";
import { isPlainObject, type FieldPath } from "../document";

/** Why a value cannot be written into a generated module. */
export type SerializeFailure = {
  readonly message: string;
  readonly fieldPath: FieldPath;
};

const failureMarker = Symbol("serialize-failure");

type ThrownFailure = SerializeFailure & { readonly [failureMarker]: true };

function fail(message: string, fieldPath: FieldPath): ThrownFailure {
  // `fieldPath` is the walker's own stack: keep a copy.
  return { message, fieldPath: [...fieldPath], [failureMarker]: true };
}

function isThrownFailure(cause: unknown): cause is ThrownFailure {
  return Predicate.isObject(cause) && failureMarker in cause;
}

function describe(value: unknown): string {
  if (Predicate.isFunction(value)) return "a function";
  if (Predicate.isSymbol(value)) return "a symbol";
  if (Predicate.isObject(value)) {
    const proto: object | null = Object.getPrototypeOf(value);
    const name =
      proto && "constructor" in proto && Predicate.isFunction(proto.constructor)
        ? proto.constructor.name
        : "object";
    return `a ${name} instance`;
  }
  return String(value);
}

/**
 * Deepest nesting written into a generated module. Deeper values fail with
 * a field path instead of a stack overflow (and would not parse back).
 */
const MAX_DEPTH = 1000;

const TOO_DEEP = "value is nested too deeply to write into a generated module";

function propertyKey(key: string): string {
  if (key === "__proto__") return '["__proto__"]';
  return JSON.stringify(key);
}

/**
 * Literals of frozen documents (objects with `_meta`: exported documents,
 * list rows, embedded documents). The engine deep-freezes document data, so
 * such an object always gives the same text; a document that is part of
 * several builds, lists and views is written once.
 */
const literals = new WeakMap<object, string>();

function serialize(
  value: unknown,
  path: (string | number)[],
  active: Set<object>,
  remember = true,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Predicate.isString(value)) return JSON.stringify(value);
  if (Predicate.isBoolean(value)) return value ? "true" : "false";
  if (Predicate.isNumber(value)) {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (Predicate.isBigInt(value)) return `${value.toString()}n`;
  if (value instanceof Date) {
    const time = value.getTime();
    return `new Date(${Number.isNaN(time) ? "NaN" : String(time)})`;
  }
  if (!Predicate.isObject(value) && !Array.isArray(value)) {
    throw fail(`cannot write ${describe(value)} into a generated module`, path);
  }
  if (active.has(value)) {
    throw fail("value contains a circular reference", path);
  }
  if (path.length >= MAX_DEPTH) throw fail(TOO_DEEP, path);
  const memoized =
    isPlainObject(value) &&
    Object.hasOwn(value, "_meta") &&
    Object.isFrozen(value);
  if (memoized) {
    const known = literals.get(value);
    if (known !== undefined) return known;
  }
  // `path` is one stack for the whole walk: a failure copies it.
  const at = (segment: string | number, input: unknown): string => {
    path.push(segment);
    const code = serialize(input, path, active);
    path.pop();
    return code;
  };
  const write = (): string => {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(at(index, value[index]));
      }
      return `[${items.join(",")}]`;
    }
    if (value instanceof Map) {
      const entries: string[] = [];
      let index = 0;
      for (const [key, item] of value) {
        path.push(index);
        entries.push(`[${at(0, key)},${at(1, item)}]`);
        path.pop();
        index += 1;
      }
      return `new Map([${entries.join(",")}])`;
    }
    if (value instanceof Set) {
      const items: string[] = [];
      let index = 0;
      for (const item of value) {
        items.push(at(index, item));
        index += 1;
      }
      return `new Set([${items.join(",")}])`;
    }
    if (!isPlainObject(value)) {
      throw fail(
        `cannot write ${describe(value)} into a generated module; return plain data from schemas and transforms`,
        path,
      );
    }
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
      parts.push(`${propertyKey(key)}:${at(key, value[key])}`);
    }
    return `{${parts.join(",")}}`;
  };
  active.add(value);
  let code: string;
  try {
    code = write();
  } finally {
    active.delete(value);
  }
  if (memoized && remember) literals.set(value, code);
  return code;
}

export type SerializeResult =
  | { readonly ok: true; readonly code: string }
  | ({ readonly ok: false } & SerializeFailure);

export type SerializeOptions = {
  /**
   * `false`: do not keep the text of `value` itself for later calls (the
   * values inside it are still shared). For large values written once, such
   * as a whole document module.
   */
  readonly remember?: boolean;
};

/**
 * JavaScript expression that rebuilds `value`: JSON-like data plus `Date`,
 * `Map`, `Set`, `BigInt`, `undefined`, `NaN` / `±Infinity` and `-0`.
 * Shared references are written out in full; cycles, functions, symbols,
 * class instances and values nested deeper than 1000 levels fail with the
 * field path.
 */
export function toJsLiteral(
  value: unknown,
  options: SerializeOptions = {},
): SerializeResult {
  try {
    return {
      ok: true,
      code: serialize(value, [], new Set(), options.remember !== false),
    };
  } catch (cause) {
    if (isThrownFailure(cause)) {
      return { ok: false, message: cause.message, fieldPath: cause.fieldPath };
    }
    if (cause instanceof RangeError) {
      return { ok: false, message: TOO_DEEP, fieldPath: [] };
    }
    throw cause;
  }
}

/** Header of every generated module. */
export const GENERATED_HEADER = "// generated by @anhur/core — do not edit";
