import { createHash } from "node:crypto";
import { Predicate } from "effect";
import { constructorName, fingerprint } from "./fingerprint";

/** Nesting at which the walk of a schema stops (a getter that makes a new schema on every read). */
const MAX_DEPTH = 64;
/** Most values the walk of one schema visits. */
const MAX_VALUES = 50_000;

type State = {
  /** Values seen so far: a second visit is a reference to the first. */
  readonly seen: Map<object, number>;
  left: number;
};

/**
 * Text that says what a schema does: the definitions of the schema and of
 * everything in it. Zod keeps the definition of a schema or check in
 * `_zod.def`, which is not enumerable, and makes `shape` and
 * `defaultValue` getters, so this walk reads both. Values that are not
 * containers (and functions, by their source) go to `fingerprint`.
 */
function canonical(value: unknown, state: State, depth: number): string {
  if (Predicate.isFunction(value) || !Predicate.isObjectOrArray(value)) {
    return fingerprint(value);
  }
  const known = state.seen.get(value);
  if (known !== undefined) return `seen:${known}`;
  if (depth > MAX_DEPTH || state.left <= 0) return "cut";
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
  if (
    value instanceof Date ||
    value instanceof RegExp ||
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
      return `zod(${canonical(internals.def, state, depth + 1)})`;
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

/**
 * Fingerprint of a Zod schema: its shape, its checks with their values,
 * its defaults and the source of its functions. Two schemas with the same
 * fingerprint validate the same input to the same output, as far as code
 * can tell from outside: a function that reads a variable has the same
 * source whatever the variable holds.
 *
 * A default given as a function is called. One that returns something new
 * on every call (the time, a random id) gives a new fingerprint in every
 * process, so documents of such a schema are never reused from disk.
 */
export function schemaFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(canonical(value, { seen: new Map(), left: MAX_VALUES }, 0))
    .digest("hex");
}
