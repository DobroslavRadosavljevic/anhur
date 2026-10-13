import { createHash } from "node:crypto";
import { Predicate } from "effect";
import { constructorName, fingerprint } from "./fingerprint";

/**
 * Nesting at which the walk of a schema stops. Each schema level takes two
 * or three steps (schema, definition, shape), so this is far above any real
 * schema; only a getter that makes a new schema on every read gets here.
 */
const MAX_DEPTH = 600;
/** Most values the walk of one schema visits. */
const MAX_VALUES = 500_000;
/** Zod marks the function it makes for `.catch(value)` with this key. */
const CONSTANT_CATCH = "~constantCatch";

type State = {
  /** Values seen so far: a second visit is a reference to the first. */
  readonly seen: Map<object, number>;
  left: number;
  /** True when the walk stopped early: the text does not hold the whole schema. */
  cut: boolean;
};

/** What a function of a schema does, as far as it can be read from outside. */
function functionText(value: Function, state: State, depth: number): string {
  // `.catch("a")`: Zod wraps the value in a function. Read the value.
  if (Reflect.get(value, CONSTANT_CATCH) === true) {
    try {
      const constant: unknown = Reflect.apply(value, undefined, []);
      return `constant(${canonical(constant, state, depth + 1)})`;
    } catch {
      return "constant(throws)";
    }
  }
  return fingerprint(value);
}

/**
 * Text that says what a schema does: the definitions of the schema and of
 * everything in it. Zod keeps the definition of a schema or check in
 * `_zod.def`, which is not enumerable, and makes `shape` and
 * `defaultValue` getters, so this walk reads both. Values that are not
 * containers (and functions, by their source) go to `fingerprint`.
 */
function canonical(value: unknown, state: State, depth: number): string {
  if (Predicate.isFunction(value)) return functionText(value, state, depth);
  if (!Predicate.isObjectOrArray(value)) return fingerprint(value);
  const known = state.seen.get(value);
  if (known !== undefined) return `seen:${known}`;
  if (depth > MAX_DEPTH || state.left <= 0) {
    state.cut = true;
    return "cut";
  }
  state.left -= 1;
  state.seen.set(value, state.seen.size);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map((item) => canonical(item, state, depth + 1)).join(",")}]`;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([key, item]) =>
        `${canonical(key, state, depth + 1)}=>${canonical(item, state, depth + 1)}`,
    );
    return `Map{${entries.join(",")}}`;
  }
  if (value instanceof Set) {
    const items = [...value.values()].map((item) =>
      canonical(item, state, depth + 1),
    );
    return `Set{${items.join(",")}}`;
  }
  // A check keeps the place it stopped at (`lastIndex`): not part of the schema.
  if (value instanceof RegExp) return `r:/${value.source}/${value.flags}`;
  if (
    value instanceof Date ||
    value instanceof URL ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer
  ) {
    return fingerprint(value);
  }
  if ("_zod" in value) {
    const internals: unknown = value._zod;
    if (Predicate.isObject(internals) && "def" in internals) {
      const definition = canonical(internals.def, state, depth + 1);
      // `.check(fn)` keeps the function beside the definition, not in it.
      const check: unknown = "check" in internals ? internals.check : undefined;
      return Predicate.isFunction(check)
        ? `zod(${definition};${fingerprint(check)})`
        : `zod(${definition})`;
    }
  }
  if (
    "type" in value &&
    value.type === "lazy" &&
    "getter" in value &&
    Predicate.isFunction(value.getter)
  ) {
    // Zod keeps the schema of `z.lazy()` in the definition after its first
    // use. Read it from the getter, so the text is the same before and after.
    let inner: string;
    try {
      const made: unknown = value.getter();
      inner = canonical(made, state, depth + 1);
    } catch {
      inner = "throws";
    }
    return `lazy(${inner})`;
  }
  const fields = Object.keys(value)
    .sort()
    .map((key) => {
      let text: string;
      try {
        text = canonical(Reflect.get(value, key), state, depth + 1);
      } catch {
        // A getter that throws: the same text every time.
        text = "throws";
      }
      return `${JSON.stringify(key)}:${text}`;
    });
  return `${constructorName(value)}{${fields.join(",")}}`;
}

/** One walk of a schema: its text as a hash, or `undefined` when the walk was cut. */
function walkOnce(value: unknown): string | undefined {
  const state: State = { seen: new Map(), left: MAX_VALUES, cut: false };
  const text = canonical(value, state, 0);
  return state.cut
    ? undefined
    : createHash("sha256").update(text).digest("hex");
}

/** The fingerprint of a schema, or why it has none. */
export type SchemaFingerprint =
  | { readonly value: string; readonly problem?: undefined }
  | { readonly value?: undefined; readonly problem: string };

/**
 * Fingerprint of a Zod schema: its shape, its checks with their values,
 * its defaults and catch values, and the source of its functions.
 *
 * What it cannot see: a function is known by its source only. Two
 * functions with the same source that read different variables (the
 * function of `.superRefine()`, a transform that calls a helper) look the
 * same. The modules such a function comes from are part of the config
 * fingerprint instead.
 *
 * A default given as a function is called (twice). A schema whose text is
 * new on every read (`.default(() => new Date())`, a random id) or that is
 * too large to walk has no fingerprint: `problem` says why, and documents
 * of such a schema are not kept on disk.
 */
export function schemaFingerprint(value: unknown): SchemaFingerprint {
  const first = walkOnce(value);
  if (first === undefined) {
    return { problem: "the schema is too large to fingerprint" };
  }
  if (walkOnce(value) !== first) {
    return {
      problem:
        "the schema gives a new value on every read (a default such as () => new Date())",
    };
  }
  return { value: first };
}
