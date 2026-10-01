import { Predicate } from "effect";
import type { ListSort } from "../define/types";
import type { DocumentFields, DocumentValue } from "../document";

const collator = new Intl.Collator("und", { numeric: true });

function rank(value: DocumentValue): number {
  if (Predicate.isNumber(value) || Predicate.isBigInt(value)) return 0;
  if (Predicate.isString(value)) return 1;
  if (Predicate.isBoolean(value)) return 2;
  if (value instanceof Date) return 3;
  return 4;
}

/**
 * Numbers and bigints by exact value (`<` compares mixed number / bigint
 * without rounding); `NaN` after every other number.
 */
function compareNumeric(a: DocumentValue, b: DocumentValue): number {
  const aNaN = Predicate.isNumber(a) && Number.isNaN(a);
  const bNaN = Predicate.isNumber(b) && Number.isNaN(b);
  if (aNaN || bNaN) return aNaN === bNaN ? 0 : aNaN ? 1 : -1;
  if (
    (Predicate.isNumber(a) || Predicate.isBigInt(a)) &&
    (Predicate.isNumber(b) || Predicate.isBigInt(b))
  ) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return 0;
}

/**
 * Total order for sort keys: numbers (exact, `NaN` last), then strings
 * (root-locale collation, numeric), booleans, dates (invalid dates last),
 * everything else. The same on every machine.
 */
export function compareValues(a: DocumentValue, b: DocumentValue): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return compareNumeric(a, b);
  if (Predicate.isString(a) && Predicate.isString(b)) {
    return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  }
  if (Predicate.isBoolean(a) && Predicate.isBoolean(b)) {
    return Number(a) - Number(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return compareNumeric(a.getTime(), b.getTime());
  }
  return 0;
}

/** Stable sort by a field; missing values (`null` / `undefined`) go last. */
export function sortRows<T extends DocumentFields>(
  rows: readonly T[],
  listSort: ListSort | undefined,
): T[] {
  return sortBy(rows, listSort, (row) => row);
}

/** {@link sortRows} for items that carry a row (`select` picks it). */
export function sortBy<T>(
  items: readonly T[],
  listSort: ListSort | undefined,
  select: (item: T) => DocumentFields,
): T[] {
  if (!listSort) return [...items];
  const direction = listSort.order === "desc" ? -1 : 1;
  return [...items].sort((leftItem, rightItem) => {
    const a = select(leftItem)[listSort.by];
    const b = select(rightItem)[listSort.by];
    const aMissing = a === undefined || a === null;
    const bMissing = b === undefined || b === null;
    if (aMissing || bMissing)
      return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    return compareValues(a, b) * direction;
  });
}

/** Sort strings with the same collation as {@link compareValues}. */
export function compareKeys(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
