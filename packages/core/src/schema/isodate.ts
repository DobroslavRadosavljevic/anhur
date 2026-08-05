import { z } from "zod";

/**
 * Parse a date-like string and output an ISO-8601 timestamp.
 */
export function isodate() {
  return z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Invalid date string",
    })
    .transform((value) => new Date(value).toISOString());
}
