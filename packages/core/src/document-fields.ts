import { Predicate } from "effect";

/**
 * Named document/JSON-like trees. Prefer this over `Record<string, unknown>`.
 */
export type JsonPrimitive = string | number | boolean | null;

export type DocumentNode =
  | JsonPrimitive
  | undefined
  | Date
  | DocumentNode[]
  | DocumentFields;

export type DocumentFields = {
  [key: string]: DocumentNode;
};

export function isDocumentFields(value: unknown): value is DocumentFields {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

export function isNonEmptyString(value: DocumentNode): value is string {
  return Predicate.isString(value) && value.length > 0;
}

export function isNumberNode(value: DocumentNode): value is number {
  return Predicate.isNumber(value);
}
