import { Predicate } from "effect";

/**
 * Values Anhur can carry through the pipeline and serialize into generated
 * modules. Anything else (functions, symbols, class instances) fails the
 * build with a `serialize-failed` diagnostic.
 */
export type DocumentValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | readonly DocumentValue[]
  | ReadonlyMap<DocumentValue, DocumentValue>
  | ReadonlySet<DocumentValue>
  | DocumentFields;

/** A plain object of document values. */
export type DocumentFields = {
  [key: string]: DocumentValue;
};

/** Field path inside a document (`["author", "name"]`, `["tags", 0]`). */
export type FieldPath = readonly (string | number)[];

/**
 * Per-document metadata attached as `_meta` to every generated document.
 */
export type ContentMeta = {
  /** Logical id: path under the source (or locale) folder, without extension. */
  id: string;
  /** Source file path relative to the project directory (POSIX separators). */
  filePath: string;
  /** Path relative to the collection / singleton directory (POSIX separators). */
  relativePath: string;
  /** File extension including the dot (for example `.mdx`). */
  extension: string;
  /** Present when the source is localized. */
  locale?: string;
};

/** Document data with its `_meta`. */
export type DocumentWithMeta<TData> = TData & { _meta: ContentMeta };

/** True for plain objects (`{}` literals, `Object.create(null)`). */
export function isPlainObject<T>(value: T): value is T & DocumentFields {
  if (value === null || typeof value !== "object") return false;
  const proto: object | null = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read a value at a field path, or `undefined` when a segment is missing. */
export function readPath(root: DocumentValue, path: FieldPath): DocumentValue {
  let current: DocumentValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!Predicate.isNumber(segment)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isPlainObject(current) || !Predicate.isString(segment)) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Set an own property, also for the key `__proto__` (a plain assignment
 * would replace the prototype instead of adding a field).
 */
export function setField(
  target: DocumentFields,
  key: string,
  value: DocumentValue,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

/**
 * Write a value at a field path in place. Returns `false` when a parent
 * container is missing (nothing is created). Only own properties are
 * followed, so `__proto__` / `constructor` segments never reach a prototype.
 */
export function writePath(
  root: DocumentFields,
  path: FieldPath,
  next: DocumentValue,
): boolean {
  if (path.length === 0) return false;
  let current: DocumentValue = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(current) && Predicate.isNumber(segment)) {
      current = current[segment];
    } else if (
      isPlainObject(current) &&
      Predicate.isString(segment) &&
      Object.hasOwn(current, segment)
    ) {
      current = current[segment];
    } else {
      return false;
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(current) && Predicate.isNumber(last)) {
    // SAFETY: arrays reached through document data are mutable copies owned by the engine.
    (current as DocumentValue[])[last] = next;
    return true;
  }
  if (isPlainObject(current) && Predicate.isString(last)) {
    setField(current, last, next);
    return true;
  }
  return false;
}

/** Human-readable field path (`author.name`, `tags[0]`). */
export function formatFieldPath(path: FieldPath | undefined): string {
  if (!path || path.length === 0) return "";
  let out = "";
  for (const segment of path) {
    if (Predicate.isNumber(segment)) out += `[${segment}]`;
    else out += out.length === 0 ? segment : `.${segment}`;
  }
  return out;
}
