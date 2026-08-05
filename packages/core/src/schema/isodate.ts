import { z } from "zod";

function toIsoTimestamp(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Accept a date string or a `Date` (gray-matter / YAML often parse bare
 * dates as `Date`) and output an ISO-8601 timestamp string.
 */
export function isodate() {
  return z.union([z.string(), z.date()]).transform((value, ctx) => {
    const iso = toIsoTimestamp(value);
    if (iso == null) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid date",
      });
      return z.NEVER;
    }
    return iso;
  });
}
