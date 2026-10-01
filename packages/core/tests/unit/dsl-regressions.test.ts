import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCollection, schema as s } from "../../src";
import {
  isPlainObject,
  writePath,
  type DocumentFields,
} from "../../src/document";
import { checkUniqueness } from "../../src/engine/constraints";
import { fingerprint } from "../../src/engine/fingerprint";
import { deepFreeze } from "../../src/engine/freeze";
import { omitDeep } from "../../src/engine/list-rows";
import { resolveRelations } from "../../src/engine/relations";
import {
  resolveProject,
  type ResolvedProject,
  type ResolvedSource,
} from "../../src/engine/resolve";
import { toJsLiteral } from "../../src/engine/serialize";
import { compareValues, sortRows } from "../../src/engine/sort";
import type {
  FinalDocument,
  SourceDocuments,
  ValidatedDocument,
} from "../../src/engine/types";
import { splitFrontmatter, yamlLoader } from "../../src/loaders";
import { slugDropsCharacters, slugify } from "../../src/naming";
import { parseIsoDate } from "../../src/schema/builtin-fields";
import { markUnique, readFieldSpec } from "../../src/schema/field";
import {
  analyzeSchema,
  formatPattern,
  walkData,
  walkInput,
} from "../../src/schema/walk";

function resolved(content: readonly unknown[]): ResolvedProject {
  const result = resolveProject(
    { content },
    {
      configPath: "/p/anhur.config.ts",
      mode: "build",
      sourceFingerprint: "x",
    },
  );
  if (!result.project) {
    throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  }
  return result.project;
}

function sourceOf(project: ResolvedProject, name: string): ResolvedSource {
  const source = project.sources.find((entry) => entry.name === name);
  if (!source) throw new Error(`no source ${name}`);
  return source;
}

function finalDocument(
  source: ResolvedSource,
  id: string,
  data: DocumentFields,
): FinalDocument {
  return {
    file: {
      source,
      absPath: `/p/${source.name}/${id}.md`,
      id,
      locale: undefined,
      meta: {
        id,
        filePath: `${source.name}/${id}.md`,
        relativePath: `${id}.md`,
        extension: ".md",
      },
    },
    data,
    effects: { assets: [], dependencies: [], cacheKeys: [] },
  };
}

function validatedOf(
  document: FinalDocument,
  data: DocumentFields,
): ValidatedDocument {
  return {
    file: document.file,
    hash: "",
    draft: false,
    data,
    effects: document.effects,
  };
}

function group(
  source: ResolvedSource,
  documents: FinalDocument[],
): SourceDocuments<FinalDocument> {
  return { source, documents };
}

const authors = defineCollection({
  name: "authors",
  directory: "authors",
  include: "*.yml",
  schema: s.object({ name: s.string() }),
});

describe("discriminated unions (H2, H3)", () => {
  const sharedSlug = s.slug();
  const posts = defineCollection({
    name: "posts",
    directory: "posts",
    include: "*.md",
    schema: s.discriminatedUnion("kind", [
      s.object({
        kind: s.literal("post"),
        slug: sharedSlug,
        author: s.reference("authors", { embed: true }),
      }),
      s.object({
        kind: s.literal("guest"),
        slug: sharedSlug,
        author: s.string(),
      }),
      s.object({ kind: s.literal("note"), slug: s.slug() }),
    ]),
  });
  const project = resolved([authors, posts]);
  const authorSource = sourceOf(project, "authors");
  const postSource = sourceOf(project, "posts");

  it("lists a helper shared by several variants once", () => {
    const slugs = analyzeSchema(posts.schema).fields.filter(
      (field) => field.spec.type === "compile",
    );
    expect(slugs.map((field) => formatPattern(field.pattern))).toEqual([
      "slug",
      "slug",
    ]);
    expect(new Set(slugs.map((field) => field.spec)).size).toBe(2);
    expect(postSource.uniques).toHaveLength(1);
  });

  it("never reports a document as a duplicate of itself, but still checks across variants", () => {
    const a = finalDocument(postSource, "a", {
      kind: "post",
      slug: "a",
      author: "ada",
    });
    const b = finalDocument(postSource, "b", { kind: "note", slug: "b" });
    expect(checkUniqueness([group(postSource, [a, b])])).toEqual([]);
    const clash = finalDocument(postSource, "c", { kind: "note", slug: "a" });
    const diagnostics = checkUniqueness([group(postSource, [a, b, clash])]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Duplicate slug "a": already used by posts/a.md.',
    ]);
  });

  it("checks and embeds references only in the variant that declares them", () => {
    const ada = finalDocument(authorSource, "ada", { name: "Ada" });
    const post = finalDocument(postSource, "p", {
      kind: "post",
      slug: "p",
      author: "ada",
    });
    const guest = finalDocument(postSource, "g", {
      kind: "guest",
      slug: "g",
      author: "ada",
    });
    const freeText = finalDocument(postSource, "f", {
      kind: "guest",
      slug: "f",
      author: "A visiting writer",
    });
    const diagnostics = resolveRelations(
      project,
      [group(authorSource, [ada]), group(postSource, [post, guest, freeText])],
      [],
    );
    expect(diagnostics).toEqual([]);
    expect(post.data.author).toMatchObject({ name: "Ada" });
    expect(guest.data.author).toBe("ada");
    expect(freeText.data.author).toBe("A visiting writer");
  });
});

describe("references and transforms (M2)", () => {
  const posts = defineCollection({
    name: "posts",
    directory: "posts",
    include: "*.md",
    schema: s.object({ author: s.reference("authors", { embed: true }) }),
  });
  const project = resolved([authors, posts]);
  const authorSource = sourceOf(project, "authors");
  const postSource = sourceOf(project, "posts");
  const people = () =>
    group(authorSource, [
      finalDocument(authorSource, "ada", { name: "Ada" }),
      finalDocument(authorSource, "bob", { name: "Bob" }),
    ]);

  it("checks the schema value even when the transform renames the field", () => {
    const post = finalDocument(postSource, "p", { writer: "nobody" });
    const diagnostics = resolveRelations(
      project,
      [people(), group(postSource, [post])],
      [validatedOf(post, { author: "nobody" })],
    );
    expect(diagnostics.map((d) => [d.code, d.fieldPath])).toEqual([
      ["reference-failed", ["author"]],
    ]);
    expect(post.data.writer).toBe("nobody");
  });

  it("checks and embeds a value the transform put at the reference location", () => {
    const changed = finalDocument(postSource, "p", { author: "bob" });
    const missing = finalDocument(postSource, "q", { author: "zed" });
    const diagnostics = resolveRelations(
      project,
      [people(), group(postSource, [changed, missing])],
      [
        validatedOf(changed, { author: "ada" }),
        validatedOf(missing, { author: "ada" }),
      ],
    );
    expect(changed.data.author).toMatchObject({ name: "Bob" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.hint).toContain("The transform set this value.");
  });
});

type SlugHolder = { slug: string };

describe("schema walker (M1, M3, M4, L12)", () => {
  it("finds helpers after a pipe input stage, in catchall, codec and preprocess", () => {
    const schema = z.object({
      pre: z.preprocess((value) => value, s.reference("authors")),
      piped: z.string().pipe(s.slug()),
      codec: z.codec(z.string(), s.reference("authors"), {
        decode: (value) => value,
        encode: (value) => value,
      }),
      extra: z.object({ fixed: z.string() }).catchall(s.reference("authors")),
    });
    const analysis = analyzeSchema(schema);
    expect(analysis.issues).toEqual([]);
    expect(
      analysis.fields.map((field) => [
        field.spec.type,
        formatPattern(field.pattern),
      ]),
    ).toEqual([
      ["reference", "pre"],
      ["compile", "piped"],
      ["reference", "codec"],
      ["reference", "extra{}"],
    ]);
    expect(
      walkInput(schema, {}).map((occurrence) => occurrence.path.join(".")),
    ).toContain("piped");
    const walk = walkData(schema, {
      pre: "a",
      piped: "b",
      codec: "c",
      extra: { fixed: "x", one: "d", two: "e" },
    });
    expect(
      walk.occurrences.map((occurrence) => [
        occurrence.path.join("."),
        occurrence.field,
        occurrence.value,
      ]),
    ).toEqual([
      ["pre", "pre", "a"],
      ["piped", "piped", "b"],
      ["codec", "codec", "c"],
      ["extra.one", "extra{}", "d"],
      ["extra.two", "extra{}", "e"],
    ]);
  });

  it("reports helpers it cannot support instead of skipping them", () => {
    const issues = (schema: z.core.$ZodType) =>
      analyzeSchema(schema).issues.map((issue) => issue.message);
    expect(
      issues(z.object({ m: z.map(z.string(), s.reference("authors")) })),
    ).toEqual([expect.stringContaining("z.map()")]);
    expect(issues(z.object({ m: z.set(s.reference("authors")) }))).toEqual([
      expect.stringContaining("z.set()"),
    ]);
    expect(
      issues(z.object({ slug: z.preprocess((value) => value, s.slug()) })),
    ).toEqual([expect.stringContaining("cannot follow a transform")]);
  });

  it("follows recursive schemas (getters and z.lazy) to any depth", () => {
    type Node = { author: string; children: Node[] };
    const node: z.ZodType<Node> = z.object({
      author: s.reference("authors"),
      get children() {
        return z.array(node);
      },
    });
    const lazy: z.ZodType<Node> = z.lazy(() =>
      z.object({ author: s.reference("authors"), children: z.array(lazy) }),
    );
    const data: DocumentFields = {
      author: "a",
      children: [{ author: "b", children: [{ author: "c", children: [] }] }],
    };
    for (const schema of [node, lazy]) {
      expect(analyzeSchema(schema).fields).toHaveLength(1);
      expect(
        walkData(schema, data).occurrences.map((occurrence) =>
          occurrence.path.join("."),
        ),
      ).toEqual([
        "author",
        "children.0.author",
        "children.0.children.0.author",
      ]);
    }
  });

  it("writes a defaulted container into the input when a compiled field needs it", () => {
    // SAFETY: the slug is computed before Zod runs, so an empty default is valid input at runtime.
    const empty = {} as SlugHolder;
    const schema = z.object({
      seo: s.object({ slug: s.slug() }).default(empty),
      pre: s.object({ slug: s.slug() }).prefault(empty),
      meta: s.object({ sku: s.unique() }).default({ sku: "x" }),
    });
    const input: DocumentFields = {};
    const found = walkInput(schema, input);
    expect(found.map((occurrence) => occurrence.path.join("."))).toEqual([
      "seo.slug",
      "pre.slug",
      "meta.sku",
    ]);
    expect(input).toEqual({ seo: {}, pre: {} });
    expect(writePath(input, ["seo", "slug"], "home")).toBe(true);
    expect(writePath(input, ["pre", "slug"], "about")).toBe(true);
    const parsed = schema.parse(input);
    expect(parsed.seo).toEqual({ slug: "home" });
    expect(parsed.pre).toEqual({ slug: "about" });
  });

  it("knows the top-level keys of unions and intersections", () => {
    const union = analyzeSchema(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), slug: z.string(), url: z.string() }),
        z.object({ kind: z.literal("b"), slug: z.string() }),
      ]),
    );
    expect(union.rootKeys).toEqual(["kind", "slug", "url"]);
    expect(union.commonRootKeys).toEqual(["kind", "slug"]);
    const intersection = analyzeSchema(
      z.object({ a: z.string() }).and(z.object({ slug: z.string() })),
    );
    expect(intersection.commonRootKeys).toEqual(["a", "slug"]);
    const posts = defineCollection({
      name: "posts",
      directory: "posts",
      include: "*.md",
      schema: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), slug: s.slug(), url: z.string() }),
        z.object({ kind: z.literal("b"), slug: s.slug() }),
      ]),
      generate: { listSort: { by: "url" } },
    });
    const source = sourceOf(resolved([posts]), "posts");
    expect(source.kind === "collection" && source.generate.lookupBy).toEqual([
      "slug",
    ]);
  });
});

describe("field markers", () => {
  it("are found without the Zod registry (another Zod copy)", () => {
    const marked = s.reference("authors");
    const refined = marked.refine((value) => value.length > 0);
    z.globalRegistry.remove(marked);
    z.globalRegistry.remove(refined);
    expect(readFieldSpec(marked)?.type).toBe("reference");
    expect(readFieldSpec(refined)?.type).toBe("reference");
  });
});

describe("unique values (L10)", () => {
  it('does not treat 1 and "1" as the same value', () => {
    const items = defineCollection({
      name: "items",
      directory: "items",
      include: "*.yml",
      schema: z.object({
        code: markUnique(z.union([z.string(), z.number()]), {}),
      }),
    });
    const source = sourceOf(resolved([items]), "items");
    expect(
      checkUniqueness([
        group(source, [
          finalDocument(source, "a", { code: 1 }),
          finalDocument(source, "b", { code: "1" }),
        ]),
      ]),
    ).toEqual([]);
  });
});

describe("slugify (M9)", () => {
  it("transliterates letters that do not decompose", () => {
    expect(slugify("Đorđe")).toBe("djordje");
    expect(slugify("Straße")).toBe("strasse");
    expect(slugify("Łódź")).toBe("lodz");
    expect(slugify("Æsir Øl")).toBe("aesir-ol");
    expect(slugify("Ђорђе Балашевић")).toBe("djordje-balashevic");
    expect(slugify("Привет мир")).toBe("privet-mir");
  });

  it("flags names whose letters have no ASCII spelling", () => {
    expect(slugify("你好 world")).toBe("world");
    expect(slugDropsCharacters("你好 world")).toBe(true);
    expect(slugDropsCharacters("Ђорђе")).toBe(false);
  });
});

describe("parseIsoDate (L1, L2)", () => {
  const iso = (value: string) => {
    const parsed = parseIsoDate(value);
    return parsed.ok ? new Date(parsed.epoch).toISOString() : parsed.reason;
  };

  it("keeps years 0–99 and accepts year 0 as a leap year", () => {
    expect(iso("0024-03-01")).toBe("0024-03-01T00:00:00.000Z");
    expect(iso("0000-02-29")).toBe("0000-02-29T00:00:00.000Z");
    expect(iso("1900-02-29")).toContain("not a calendar date");
  });

  it("truncates fractions and limits offsets to ±14:00", () => {
    expect(iso("2024-12-31T23:59:59.9996Z")).toBe("2024-12-31T23:59:59.999Z");
    expect(iso("2024-01-01T00:00:00-14:59")).toContain("invalid UTC offset");
    expect(iso("2024-01-01T00:00:00+14:00")).toBe("2023-12-31T10:00:00.000Z");
  });
});

describe("loaders (L4, L5)", () => {
  it("supports YAML merge keys", async () => {
    const loaded = await yamlLoader.load({
      raw: "base: &d\n  a: 1\nchild:\n  <<: *d\n  b: 2\n",
      path: "x.yml",
    });
    expect(loaded.data).toEqual({ base: { a: 1 }, child: { a: 1, b: 2 } });
  });

  it("treats a leading thematic break as Markdown", () => {
    expect(splitFrontmatter("----\n\nText\n")).toEqual({
      frontmatter: undefined,
      body: "----\n\nText\n",
    });
    expect(splitFrontmatter("---\n\nText after a break\n")).toEqual({
      frontmatter: undefined,
      body: "---\n\nText after a break\n",
    });
    expect(() => splitFrontmatter("---\ntitle: x\nBody\n")).toThrow(
      "not closed",
    );
    expect(splitFrontmatter("---yaml\na: 1\n---\nB")).toEqual({
      frontmatter: "a: 1\n",
      body: "B",
    });
  });
});

describe("fingerprint (L7)", () => {
  it("tells arrays, Map / Set order, URLs, symbols and instances apart", () => {
    expect(fingerprint([{ a: 1 }])).not.toBe(fingerprint([{ a: 2 }]));
    expect(fingerprint(["a,b"])).not.toBe(fingerprint(["a", "b"]));
    expect(
      fingerprint(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).not.toBe(
      fingerprint(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    );
    expect(fingerprint(new Set([1, 2]))).not.toBe(fingerprint(new Set([2, 1])));
    expect(fingerprint(new URL("https://a/"))).not.toBe(
      fingerprint(new URL("https://b/")),
    );
    expect(fingerprint(Symbol("x"))).not.toBe(fingerprint(Symbol("x")));
    expect(fingerprint(Symbol.for("x"))).toBe(fingerprint(Symbol.for("x")));
    class Secret {
      readonly #value: string;
      constructor(value: string) {
        this.#value = value;
      }
      toString(): string {
        return `Secret(${this.#value})`;
      }
    }
    expect(fingerprint(new Secret("a"))).not.toBe(fingerprint(new Secret("b")));
  });

  it("handles heavily shared values in linear time", () => {
    let value: DocumentFields = { leaf: 1 };
    for (let depth = 0; depth < 64; depth += 1) value = { a: value, b: value };
    const started = performance.now();
    fingerprint(value);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

function nested(depth: number): DocumentFields {
  let value: DocumentFields = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("deep data (L8)", () => {
  it("reports values nested too deeply instead of overflowing the stack", () => {
    const result = toJsLiteral(nested(12_000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("nested too deeply");
    expect(() => deepFreeze(nested(12_000))).not.toThrow();
  });
});

describe("__proto__ keys (L9)", () => {
  it("keeps own __proto__ fields as data", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1},"body":"b"}');
    if (!isPlainObject(parsed)) throw new Error("fixture");
    const data: DocumentFields = parsed;
    const row = omitDeep(data, new Set(["body"]));
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    const target: DocumentFields = {};
    expect(writePath(target, ["__proto__"], 1)).toBe(true);
    expect(Object.hasOwn(target, "__proto__")).toBe(true);
    expect(writePath({}, ["__proto__", "polluted"], 1)).toBe(false);
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });
});

describe("deepFreeze (L11)", () => {
  it("makes Map, Set and Date values read-only", () => {
    const data: DocumentFields = {
      map: new Map([["k", { v: 1 }]]),
      set: new Set([[1]]),
      date: new Date(0),
    };
    deepFreeze(data);
    const { map, set, date } = data;
    if (
      !(map instanceof Map) ||
      !(set instanceof Set) ||
      !(date instanceof Date)
    )
      throw new Error("fixture");
    expect(() => map.set("x", 1)).toThrow(TypeError);
    expect(() => map.clear()).toThrow(TypeError);
    expect(() => set.add(1)).toThrow(TypeError);
    expect(() => date.setTime(5)).toThrow(TypeError);
    expect(Object.isFrozen(map.get("k"))).toBe(true);
    expect(map.get("k")).toEqual({ v: 1 });
    expect(date.getTime()).toBe(0);
  });
});

describe("sort order (L15)", () => {
  it("puts NaN last and compares bigints exactly", () => {
    const rows = [3, Number.NaN, 1, Number.NaN, 2].map((n) => ({ n }));
    expect(sortRows(rows, { by: "n" }).map((row) => String(row.n))).toEqual([
      "1",
      "2",
      "3",
      "NaN",
      "NaN",
    ]);
    expect(compareValues(2n ** 60n + 1n, 2n ** 60n)).toBe(1);
    expect(compareValues(2 ** 53, 2n ** 53n + 1n)).toBe(-1);
    expect(compareValues(1.5, 1n)).toBe(1);
  });
});
