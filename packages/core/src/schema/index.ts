import { z } from "zod";
import {
  excerpt,
  isodate,
  metadata,
  raw,
  reference,
  slug,
  toc,
  unique,
} from "./builtin-fields";

/**
 * Zod plus Anhur field helpers. Import as `import { schema as s } from "@anhur/core"`.
 *
 * - `s.slug()` — explicit or derived URL slug (unique per locale)
 * - `s.reference("authors", { embed })` — id of another document
 * - `s.unique()` — unique string, checked on output documents
 * - `s.isodate()` — strict ISO 8601 date string
 * - `s.raw()` / `s.excerpt()` / `s.metadata()` / `s.toc()` — from the body
 */
export const schema = {
  ...z,
  raw,
  unique,
  slug,
  reference,
  isodate,
  excerpt,
  metadata,
  toc,
};
