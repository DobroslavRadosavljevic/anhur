import { isPlainObject, type DocumentValue } from "../document";
import { copyData } from "./copy-data";
import { findNonPlainData } from "./plain-data";

const DATE_SETTERS = Object.getOwnPropertyNames(Date.prototype).filter((name) =>
  name.startsWith("set"),
);

function readOnly(kind: string, method: string): () => never {
  return () => {
    throw new TypeError(
      `Cannot call ${method}() on a read-only ${kind}: content data is frozen at this stage.`,
    );
  };
}

/**
 * `Object.freeze` does not stop `Map#set`, `Set#add` or `Date#setTime`
 * (they change internal slots). Shadow the mutating methods with
 * non-writable throwing ones, then freeze the instance.
 */
type LockableValue =
  | ReadonlyMap<DocumentValue, DocumentValue>
  | ReadonlySet<DocumentValue>
  | Date;

function lock(
  target: LockableValue,
  kind: string,
  methods: readonly string[],
): void {
  for (const method of methods) {
    Object.defineProperty(target, method, {
      value: readOnly(kind, method),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(target);
}

/** A document value that can hold other values or change: not a primitive. */
type Container = Extract<DocumentValue, object>;

/**
 * Containers that {@link deepFreeze} froze together with everything below
 * them. `Object.isFrozen` does not say that: Zod freezes `.readonly()`
 * output one level deep, and a config can freeze any value it makes.
 */
const finished = new WeakSet<Container>();

/**
 * True when {@link deepFreeze} froze `value` and everything below it, so
 * `value` can never change (a primitive never can). What is remembered
 * about a value by its identity must ask this, not `Object.isFrozen`.
 */
export function isDeepFrozen(value: DocumentValue): boolean {
  return value === null || typeof value !== "object" || finished.has(value);
}

function mark(container: Container, marked: Container[]): void {
  finished.add(container);
  marked.push(container);
}

/**
 * Freeze one object or array. False when it is done already (in an
 * earlier call, or earlier in this walk): nothing below it is open.
 */
function enter(container: Container, marked: Container[]): boolean {
  if (!Object.isFrozen(container)) Object.freeze(container);
  else if (finished.has(container)) return false;
  mark(container, marked);
  return true;
}

/**
 * Freeze `root` and everything below it in place, and add every container
 * frozen here to `finished` and to `marked`. A container that someone else
 * froze is entered, because what is below it can still be open.
 *
 * @returns `false` when a `Map`, `Set` or `Date` cannot be locked: it is
 *   already frozen, and its methods still change it.
 */
function freezeInPlace(root: DocumentValue, marked: Container[]): boolean {
  const pending: DocumentValue[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (!enter(current, marked)) continue;
      const items: readonly DocumentValue[] = current;
      for (const item of items) pending.push(item);
    } else if (isPlainObject(current)) {
      if (!enter(current, marked)) continue;
      for (const item of Object.values(current)) pending.push(item);
    } else if (
      current instanceof Map ||
      current instanceof Set ||
      current instanceof Date
    ) {
      if (finished.has(current)) continue;
      // The throwing methods cannot be added to a frozen instance.
      if (!Object.isExtensible(current)) return false;
      mark(current, marked);
      if (current instanceof Map) {
        lock(current, "Map", ["set", "delete", "clear"]);
        for (const [key, item] of current) pending.push(key, item);
      } else if (current instanceof Set) {
        lock(current, "Set", ["add", "delete", "clear"]);
        for (const item of current) pending.push(item);
      } else {
        lock(current, "Date", DATE_SETTERS);
      }
    }
  }
  return true;
}

/**
 * Deep-freeze document data: objects, arrays, and `Map` / `Set` / `Date`
 * values (their mutating methods throw). Iterative, so deeply nested data
 * cannot overflow the stack.
 *
 * The data is frozen in place and returned, with one exception: a `Map`,
 * `Set` or `Date` that someone else froze (`z.date().readonly()`) cannot
 * be locked, so a frozen copy of the whole value is returned. Always use
 * the returned value.
 *
 * A container that someone else froze is not trusted: everything below it
 * is frozen too. Only what this function finished is skipped
 * ({@link isDeepFrozen}).
 */
export function deepFreeze<T extends DocumentValue>(value: T): T {
  const marked: Container[] = [];
  let done = false;
  try {
    done = freezeInPlace(value, marked);
  } finally {
    // The walk stopped early: what it marked is not frozen all the way down.
    if (!done) for (const container of marked) finished.delete(container);
  }
  if (done) return value;
  // Not plain data (a function, a class instance, a cycle): no copy. The
  // stage that writes the value reports it with its field path.
  if (findNonPlainData(value)) return value;
  return deepFreeze(copyData(value));
}

/** What engines say when code writes to a frozen value. */
const FROZEN_WRITE =
  /read[- ]?only|not extensible|cannot (?:assign|add|delete|define|set)|frozen/i;

/**
 * A hint for an error a callback threw, when the error is a write to
 * frozen data: the bare text of the engine ("Attempted to assign to
 * readonly property") does not say that documents are frozen on purpose.
 */
export function frozenWriteHint(cause: unknown): string | undefined {
  return cause instanceof TypeError && FROZEN_WRITE.test(cause.message)
    ? "Documents and their lists are frozen. Return a new object ({ ...doc, title }) or copy a list first ([...documents].sort())."
    : undefined;
}
