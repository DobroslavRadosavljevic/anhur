import { z } from "zod";
import type { ReferenceBy } from "../relations";

export type ReferenceOptions = {
  /**
   * Match target documents by `_meta.id` (default) or by a `slug` field.
   */
  by?: ReferenceBy;
  /**
   * When true, replace the string with the full referenced document
   * (`{ ...fields, _meta }`) after all sources are collected.
   */
  embed?: boolean;
};

/** Runtime marker produced by `s.reference()` until the resolve pass. */
export type ReferenceMarker = {
  readonly __anhurRef: true;
  collection: string;
  by: ReferenceBy;
  embed: boolean;
  value: string;
};

export function isReferenceMarker(value: unknown): value is ReferenceMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ReferenceMarker).__anhurRef === true &&
    typeof (value as ReferenceMarker).value === "string"
  );
}

/**
 * String id/slug that must resolve to a document in another content source.
 * Existence (and optional embed) run after the full collect pass.
 *
 * Inferred TypeScript type is `string` (or an embedded document object when
 * `embed: true` — treat as `unknown` / narrow in app code for now).
 */
export function reference(
  collection: string,
  options: ReferenceOptions = {},
): z.ZodType<string> {
  const by = options.by ?? "id";
  const embed = options.embed ?? false;

  return z.string().transform((value): ReferenceMarker => ({
    __anhurRef: true,
    collection,
    by,
    embed,
    value,
  })) as unknown as z.ZodType<string>;
}
