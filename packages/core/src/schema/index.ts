import { z } from "zod";
import { excerpt } from "./excerpt";
import { isodate } from "./isodate";
import { metadata } from "./metadata";
import { raw } from "./raw";
import { reference } from "./reference";
import { slug } from "./slug";
import { toc } from "./toc";
import { unique } from "./unique";

/**
 * Core schema helpers. Import as `import { schema as s } from "@anhur/core"`.
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

export type { UniqueOptions } from "./unique";
export type { SlugOptions } from "./slug";
export type {
  EmbeddedDocument,
  ReferenceOptions,
  ReferenceMarker,
} from "./reference";
export type { ExcerptOptions } from "./excerpt";
export type { DocumentMetadata } from "./metadata";
export type { TocEntry, TocOptions } from "./toc";
export type { ZodType, ZodTypeAny, infer as InferZod } from "zod";
