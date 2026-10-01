import { isPlainObject, type DocumentValue } from "../document";

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

/**
 * Deep-freeze document data in place: objects, arrays, and `Map` / `Set` /
 * `Date` values (their mutating methods throw). Iterative, so deeply nested
 * data cannot overflow the stack.
 */
export function deepFreeze<T extends DocumentValue>(value: T): T {
  const pending: DocumentValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (Object.isFrozen(current)) continue;
      Object.freeze(current);
      const items: readonly DocumentValue[] = current;
      for (const item of items) pending.push(item);
    } else if (isPlainObject(current)) {
      if (Object.isFrozen(current)) continue;
      Object.freeze(current);
      for (const item of Object.values(current)) pending.push(item);
    } else if (current instanceof Map) {
      if (Object.isFrozen(current)) continue;
      lock(current, "Map", ["set", "delete", "clear"]);
      for (const [key, item] of current) pending.push(key, item);
    } else if (current instanceof Set) {
      if (Object.isFrozen(current)) continue;
      lock(current, "Set", ["add", "delete", "clear"]);
      for (const item of current) pending.push(item);
    } else if (current instanceof Date) {
      if (Object.isFrozen(current)) continue;
      lock(current, "Date", DATE_SETTERS);
    }
  }
  return value;
}
