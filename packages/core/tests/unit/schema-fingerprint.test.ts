import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaFingerprint as fingerprintOf } from "../../src/engine/schema-fingerprint";

/** The fingerprint of a schema that has one. */
function schemaFingerprint(schema: unknown): string {
  const result = fingerprintOf(schema);
  if (result.value === undefined) throw new Error(result.problem);
  return result.value;
}
import { schema as s } from "../../src/index";

describe("schemaFingerprint", () => {
  it("is the same for two schemas written the same way", () => {
    const make = () =>
      s.object({
        title: s.string().max(10),
        tags: z.array(z.string()).default(() => []),
        body: s.raw(),
      });
    expect(schemaFingerprint(make())).toBe(schemaFingerprint(make()));
  });

  it("sees checks, defaults, keys and the source of functions", () => {
    const pairs: (readonly [string, z.ZodType, z.ZodType])[] = [
      ["max", z.string().max(10), z.string().max(3)],
      ["regex", z.string().regex(/a/), z.string().regex(/b/)],
      ["default", z.string().default("a"), z.string().default("b")],
      ["enum", z.enum(["a", "b"]), z.enum(["a", "c"])],
      ["optional", z.string(), z.string().optional()],
      ["key", z.object({ a: z.string() }), z.object({ b: z.string() })],
      [
        "nested",
        z.array(z.object({ n: z.number().min(1) })),
        z.array(z.object({ n: z.number().min(2) })),
      ],
      [
        "transform",
        z.string().transform((value) => `${value}a`),
        z.string().transform((value) => `${value}b`),
      ],
      [
        "refine",
        z.string().refine((value) => value.length > 1),
        z.string().refine((value) => value.length > 2),
      ],
    ];
    for (const [name, one, other] of pairs) {
      expect(schemaFingerprint(one), name).not.toBe(schemaFingerprint(other));
    }
  });

  it("sees the function of .check() and the value of .catch()", () => {
    const pairs: (readonly [string, z.ZodType, z.ZodType])[] = [
      [
        "check",
        z.string().check((ctx) => {
          if (ctx.value.length > 1)
            ctx.issues.push({
              code: "custom",
              message: "long",
              input: ctx.value,
            });
        }),
        z.string().check((ctx) => {
          if (ctx.value.length > 2)
            ctx.issues.push({
              code: "custom",
              message: "long",
              input: ctx.value,
            });
        }),
      ],
      ["catch", z.string().catch("a"), z.string().catch("b")],
      ["regex flags", z.string().regex(/a/), z.string().regex(/a/i)],
    ];
    for (const [name, one, other] of pairs) {
      expect(schemaFingerprint(one), name).not.toBe(schemaFingerprint(other));
    }
  });

  it("is the same after a /g expression was used", () => {
    // Failure: a stamp that moves with `lastIndex` never matches a stored document.
    const schema = z.string().regex(/a+/g);
    const before = schemaFingerprint(schema);
    schema.safeParse("xaa");
    schema.safeParse("aaaa");
    expect(schemaFingerprint(schema)).toBe(before);
  });

  it("gives no fingerprint to a schema that is new on every read", () => {
    // Failure: documents of such a schema would be written to the store in
    // every session and never read back.
    let calls = 0;
    const schema = z.number().default(() => {
      calls += 1;
      return calls;
    });
    const result = fingerprintOf(schema);
    expect(result.value).toBeUndefined();
    expect(result.problem).toMatch(/new value on every read/);
  });

  it("tells a change far down a deep schema", () => {
    // Failure: a walk that stops early gives two schemas one fingerprint,
    // and the stored documents of the old schema are served for the new one.
    const nest = (max: number, depth: number): z.ZodType => {
      let schema: z.ZodType = z.object({ leaf: z.string().max(max) });
      for (let level = 0; level < depth; level += 1) {
        schema = z.array(z.object({ child: schema.optional() }));
      }
      return schema;
    };
    expect(schemaFingerprint(nest(5, 40))).not.toBe(
      schemaFingerprint(nest(500, 40)),
    );
    const wide = (max: number) =>
      z.object(
        Object.fromEntries(
          Array.from({ length: 3000 }, (_, index) => [
            `k${String(index)}`,
            z.string().max(index === 2999 ? max : 5),
          ]),
        ),
      );
    expect(schemaFingerprint(wide(5))).not.toBe(schemaFingerprint(wide(500)));
  });

  it("is the same before and after a lazy schema was used", () => {
    // Zod keeps the schema of z.lazy() in its definition after the first parse.
    const make = (max: number) =>
      z.object({ toc: z.array(z.lazy(() => z.string().max(max))) });
    const schema = make(5);
    const before = schemaFingerprint(schema);
    schema.parse({ toc: ["a"] });
    expect(schemaFingerprint(schema)).toBe(before);
    expect(schemaFingerprint(s.object({ toc: s.toc() }))).toBe(
      schemaFingerprint(s.object({ toc: s.toc() })),
    );
    expect(schemaFingerprint(make(6))).not.toBe(before);
  });

  it("ends on a schema that contains itself", () => {
    type Node = { readonly name: string; readonly children: readonly Node[] };
    const node: z.ZodType<Node> = z.object({
      name: z.string(),
      get children() {
        return z.array(node);
      },
    });
    expect(schemaFingerprint(node)).toBe(schemaFingerprint(node));
  });
});
