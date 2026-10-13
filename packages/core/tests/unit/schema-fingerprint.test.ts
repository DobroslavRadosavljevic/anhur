import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaFingerprint } from "../../src/engine/schema-fingerprint";
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

  it("changes with a default that is new on every call", () => {
    let calls = 0;
    const schema = z.number().default(() => {
      calls += 1;
      return calls;
    });
    expect(schemaFingerprint(schema)).not.toBe(schemaFingerprint(schema));
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
