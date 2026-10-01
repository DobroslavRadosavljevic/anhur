import { Predicate } from "effect";
import { z } from "zod";
import type { EmbeddedDocument } from "../define/infer";
import type { DocumentValue } from "../document";
import { slugDropsCharacters, slugify } from "../naming";
import type {
  AnhurPlugin,
  FieldContext,
  HeadingExtractor,
  UniqueOptions,
} from "../plugin/types";
import { defineField, markReference, markUnique } from "./field";
import {
  BODY_PARSER_VERSION,
  countWords,
  toPlainText,
  truncateText,
} from "./text";
import {
  extractHeadings,
  tocFromHeadings,
  type TocEntry,
  type TocOptions,
} from "./toc";

function isMdx(context: FieldContext): boolean {
  return context.document.meta.extension.toLowerCase() === ".mdx";
}

function fieldKey(context: FieldContext): string {
  const last = context.fieldPath[context.fieldPath.length - 1];
  return last === undefined ? "field" : String(last);
}

/** Body-derived fields must not also be set in the file. */
function assertAbsent(input: DocumentValue, context: FieldContext): void {
  if (input !== undefined && input !== null) {
    throw new Error(
      `"${fieldKey(context)}" is computed from the document body; remove it from the file.`,
    );
  }
}

function stringInput(
  input: DocumentValue,
  context: FieldContext,
): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Predicate.isString(input)) {
    throw new Error(`"${fieldKey(context)}" must be a string.`);
  }
  return input;
}

/**
 * The document body as a string (or the field's own string value when the
 * file sets it). YAML / JSON files have no body: the result is `""`.
 */
export function raw(): z.ZodString {
  return defineField(z.string(), {
    kind: "raw",
    whenAbsent: "compile",
    compile: (input, context) =>
      stringInput(input, context) ?? context.body ?? "",
  });
}

export type ExcerptOptions = {
  /** Maximum length in characters, including the trailing `…`. Default `260`. */
  readonly length?: number;
};

/**
 * Plain-text excerpt of the body: Markdown (with GFM) or, for `.mdx`, MDX
 * is parsed; code blocks, raw HTML, images, MDX `import` / `export` and
 * `{expressions}` are left out, text inside JSX is kept. A string set in
 * the file is used as the source instead.
 */
export function excerpt(options: ExcerptOptions = {}): z.ZodString {
  const length = options.length ?? 260;
  if (!Number.isInteger(length) || length < 1) {
    throw new Error("s.excerpt({ length }) must be a positive integer.");
  }
  return defineField(z.string(), {
    kind: "excerpt",
    whenAbsent: "compile",
    compile: (input, context) => {
      const source = stringInput(input, context) ?? context.body ?? "";
      return truncateText(toPlainText(source, { mdx: isMdx(context) }), length);
    },
  });
}

export type DocumentMetadata = {
  /** Estimated reading time in minutes (`0` for an empty body). */
  readingTime: number;
  /** Words in the body, counted with the document locale's word rules. */
  wordCount: number;
};

const DocumentMetadataSchema = z.object({
  readingTime: z.number(),
  wordCount: z.number(),
});

/** Reading time and word count of the body (Unicode-aware, any script). */
export function metadata(
  options: { readonly wordsPerMinute?: number } = {},
): z.ZodType<DocumentMetadata> {
  const wordsPerMinute = options.wordsPerMinute ?? 230;
  return defineField(DocumentMetadataSchema, {
    kind: "metadata",
    whenAbsent: "compile",
    compile: (input, context): DocumentMetadata => {
      assertAbsent(input, context);
      const text = toPlainText(context.body ?? "", { mdx: isMdx(context) });
      const wordCount = countWords(text, context.document.locale);
      const readingTime =
        wordCount === 0
          ? 0
          : Math.max(1, Math.round(wordCount / wordsPerMinute));
      return { readingTime, wordCount };
    },
  });
}

const TocEntrySchema: z.ZodType<TocEntry> = z.lazy(() =>
  z.object({
    title: z.string(),
    url: z.string(),
    items: z.array(TocEntrySchema),
  }),
);

type HeadingsPlugin = AnhurPlugin & { readonly headings: HeadingExtractor };

/**
 * The body compiler whose output the TOC must match: `mdx()` for `.mdx`
 * files; otherwise `markdown()` when registered, else `mdx()`. `undefined`
 * when that plugin is missing or reports no headings (`headingIds: false`).
 */
function headingsPlugin(context: FieldContext): HeadingsPlugin | undefined {
  const names = isMdx(context) ? ["mdx"] : ["markdown", "mdx"];
  for (const name of names) {
    const plugin = context.getPlugin(name);
    if (!plugin) continue;
    const headings = plugin.headings;
    return headings ? { ...plugin, headings } : undefined;
  }
  return undefined;
}

/**
 * Table of contents from the body headings. URLs are `#id` anchors of the
 * headings in the body compiled by `@anhur/markdown` / `@anhur/mdx` (the
 * same pipeline runs to find them, so raw HTML, JSX and plugins are taken
 * into account). Without either plugin, a built-in parser with
 * `github-slugger` ids is used.
 */
export function toc(options: TocOptions = {}): z.ZodType<TocEntry[]> {
  return defineField(z.array(TocEntrySchema), {
    kind: "toc",
    whenAbsent: "compile",
    cache: {
      version: `toc-2;${BODY_PARSER_VERSION}`,
      key: (context) => {
        const plugin = headingsPlugin(context);
        return plugin
          ? `${plugin.name}@${plugin.version ?? ""};${plugin.headings.key(context)}`
          : "builtin";
      },
    },
    compile: async (input, context) => {
      assertAbsent(input, context);
      const body = context.body ?? "";
      const plugin = headingsPlugin(context);
      const headings = plugin
        ? await plugin.headings.extract(body, context)
        : extractHeadings(body, { mdx: isMdx(context) });
      return tocFromHeadings(headings, options);
    },
  });
}

export type SlugOptions = {
  /**
   * Derive a missing slug from the document id (`guides/intro` →
   * `guides-intro`, default) or from the file name only (`intro`).
   */
  readonly from?: "id" | "path";
  /** Drop a trailing `index` (`guides/index` → `guides`). */
  readonly removeIndex?: boolean;
  /**
   * Required format. Default: lowercase letters, digits, single hyphens.
   * `false` accepts any non-empty string.
   */
  readonly pattern?: RegExp | false;
  /**
   * Uniqueness (default: unique per locale, or per collection when not
   * localized). `false` turns the check off.
   */
  readonly unique?: UniqueOptions | false;
};

const DEFAULT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slug from the document id. A root `index` with `removeIndex` has no path
 * left: it derives `""` when the slug pattern accepts an empty string, and
 * `index` otherwise. Names with letters that have no ASCII spelling (`你好`)
 * cannot derive a slug: two such names would collide.
 */
function deriveSlug(
  options: SlugOptions,
  pattern: RegExp | undefined,
  context: FieldContext,
): string {
  const id = context.document.id;
  if (isRootIndex(options, context)) {
    return pattern !== undefined && matchesWhole(pattern, "") ? "" : "index";
  }
  let parts = id.split("/").filter((part) => part.length > 0);
  if (options.removeIndex && parts[parts.length - 1] === "index") {
    parts = parts.slice(0, -1);
  }
  if (options.from === "path") {
    const last = parts[parts.length - 1];
    parts = last === undefined ? [] : [last];
  }
  const lossy = parts.find((part) => slugDropsCharacters(part));
  if (lossy !== undefined) {
    throw new Error(
      `cannot derive an ASCII slug from "${id}": "${lossy}" has letters with no ASCII spelling. Set "${fieldKey(context)}" in the file.`,
    );
  }
  return parts
    .map((part) => slugify(part))
    .filter((part) => part.length > 0)
    .join("-");
}

/** `removeIndex` on the root `index` document: no path is left. */
function isRootIndex(options: SlugOptions, context: FieldContext): boolean {
  if (!options.removeIndex) return false;
  const parts = context.document.id
    .split("/")
    .filter((part) => part.length > 0);
  return parts.length === 1 && parts[0] === "index";
}

/** `pattern.test()` without the `lastIndex` state of `g` / `y` patterns. */
function matchesWhole(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * URL slug: the value from the file, or one derived from the document id
 * (ASCII, lowercase, hyphenated; `ß` → `ss`, `ђ` → `dj`, …). Unique per
 * locale by default.
 */
export function slug(options: SlugOptions = {}): z.ZodString {
  const pattern =
    options.pattern === false
      ? undefined
      : (options.pattern ?? DEFAULT_SLUG_PATTERN);
  const unique = options.unique === false ? undefined : (options.unique ?? {});
  const spec = {
    kind: "slug",
    whenAbsent: "compile" as const,
    compile: (input: DocumentValue, context: FieldContext) => {
      const explicit = stringInput(input, context);
      const derived = explicit === undefined || explicit.length === 0;
      const value = derived ? deriveSlug(options, pattern, context) : explicit;
      if (value.length === 0 && !(derived && isRootIndex(options, context))) {
        throw new Error(
          `could not derive a slug from "${context.document.id}". Set "${fieldKey(context)}" in the file.`,
        );
      }
      if (pattern && !matchesWhole(pattern, value)) {
        throw new Error(
          `slug "${value}" does not match ${String(pattern)}. Use lowercase letters, digits and single hyphens, or pass s.slug({ pattern }).`,
        );
      }
      return value;
    },
  };
  return defineField(
    z.string(),
    unique === undefined ? spec : { ...spec, unique },
  );
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]!;
}

/**
 * UTC epoch milliseconds. `Date.UTC` maps years 0–99 to 1900–1999;
 * `setUTCFullYear` does not.
 */
function utcEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

type ParsedIsoDate =
  | { readonly ok: true; readonly epoch: number; readonly dateOnly: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Strict ISO 8601 parsing: calendar-checked (no `2024-02-30` rollover).
 * Times without an offset are UTC, so results do not depend on the
 * machine time zone.
 */
export function parseIsoDate(value: string): ParsedIsoDate {
  const match = ISO_DATE.exec(value.trim());
  if (!match) {
    return {
      ok: false,
      reason: `"${value}" is not an ISO 8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss][Z|±hh:mm])`,
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, reason: `"${value}" is not a calendar date` };
  }
  if (match[4] === undefined) {
    return { ok: true, epoch: utcEpoch(year, month, day), dateOnly: true };
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  // Truncated to milliseconds (rounding `.9996` would move to the next second).
  const millisecond =
    match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, reason: `"${value}" has an invalid time` };
  }
  let offsetMinutes = 0;
  const zone = match[8];
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes > 0)) {
      return { ok: false, reason: `"${value}" has an invalid UTC offset` };
    }
    offsetMinutes = sign * (hours * 60 + minutes);
  }
  const epoch =
    utcEpoch(year, month, day, hour, minute, second, millisecond) -
    offsetMinutes * 60_000;
  return { ok: true, epoch, dateOnly: false };
}

export type IsoDateOptions = {
  /**
   * - `datetime` (default): full UTC timestamp (`2024-05-01T00:00:00.000Z`)
   * - `date`: calendar date only (`2024-05-01`)
   */
  readonly output?: "datetime" | "date";
};

/**
 * ISO 8601 date string. Accepts a string or a `Date` (YAML parses bare dates
 * as `Date`) and outputs a normalized string.
 */
export function isodate(options: IsoDateOptions = {}) {
  const output = options.output ?? "datetime";
  return z.union([z.string(), z.date()]).transform((value, ctx) => {
    let epoch: number;
    if (value instanceof Date) {
      epoch = value.getTime();
      if (Number.isNaN(epoch)) {
        ctx.addIssue({ code: "custom", message: "Invalid date" });
        return z.NEVER;
      }
    } else {
      const parsed = parseIsoDate(value);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: parsed.reason });
        return z.NEVER;
      }
      epoch = parsed.epoch;
    }
    const iso = new Date(epoch).toISOString();
    return output === "date" ? iso.slice(0, 10) : iso;
  });
}

/**
 * String that must be unique. Checked after transforms on the documents
 * that end up in the output (drafts and skipped documents never conflict).
 */
export function unique(options: UniqueOptions = {}): z.ZodString {
  return markUnique(z.string(), options);
}

export type ReferenceOptions = {
  /** Match target documents by `id` (default) or by a string field such as `slug`. */
  readonly by?: "id" | (string & {});
  /**
   * Replace the string with the full target document in the output
   * (after the target's own transform). Embed cycles are rejected.
   */
  readonly embed?: boolean;
};

/**
 * Id (or slug) of a document in another collection / singleton. The value
 * stays a string while your schema and transform run; existence is checked
 * (and `embed` resolved) after transforms.
 */
export function reference<const TSource extends string>(
  source: TSource,
  options: ReferenceOptions & { readonly embed: true },
): z.ZodType<EmbeddedDocument<TSource>, string>;
export function reference<const TSource extends string>(
  source: TSource,
  options?: ReferenceOptions & { readonly embed?: false },
): z.ZodString;
export function reference(
  source: string,
  options: ReferenceOptions = {},
): z.ZodString | z.ZodType<EmbeddedDocument<string>, string> {
  if (!source) throw new Error("s.reference() needs a source name.");
  return markReference(z.string().min(1), {
    collection: source,
    by: options.by ?? "id",
    embed: options.embed ?? false,
  });
}
