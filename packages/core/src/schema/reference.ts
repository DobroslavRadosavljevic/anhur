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

/**
 * Phantom type for `s.reference(name, { embed: true })` until
 * `GetTypeByName` remaps it to the target document shape.
 */
declare const anhurEmbeddedBrand: unique symbol;
export type EmbeddedDocument<TCollection = string> = {
  readonly [anhurEmbeddedBrand]: TCollection;
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

function referenceMarkerSchema(
  collection: string,
  by: ReferenceBy,
  embed: boolean,
) {
  return z.string().transform((value): ReferenceMarker => ({
    __anhurRef: true,
    collection,
    by,
    embed,
    value,
  }));
}

/**
 * String id/slug that must resolve to a document in another content source.
 * Existence (and optional embed) run after the full collect pass.
 *
 * - `embed: false` (default) — TypeScript type is `string`
 * - `embed: true` — TypeScript type remaps via `GetTypeByName` to the
 *   target document (`{ ...fields, _meta }`)
 */
export function reference<const TCollection extends string>(
  collection: TCollection,
  options: ReferenceOptions & { embed: true },
): z.ZodType<EmbeddedDocument<TCollection>>;
export function reference<const TCollection extends string>(
  collection: TCollection,
  options?: ReferenceOptions & { embed?: false },
): z.ZodType<string>;
export function reference(
  collection: string,
  options: ReferenceOptions = {},
): z.ZodType<string> | z.ZodType<EmbeddedDocument<string>> {
  const by = options.by ?? "id";
  const embed = options.embed ?? false;
  const schema = referenceMarkerSchema(collection, by, embed);

  if (embed) {
    return schema as unknown as z.ZodType<EmbeddedDocument<string>>;
  }
  return schema as unknown as z.ZodType<string>;
}
