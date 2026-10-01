import { describe, expect, it } from "vitest";
import {
  decodeCacheValue,
  encodeCacheValue,
} from "../../src/engine/cache-codec";
import { fingerprint } from "../../src/engine/fingerprint";
import { toJsLiteral } from "../../src/engine/serialize";
import { compareValues, sortRows } from "../../src/engine/sort";

// Generated modules are evaluated the same way a bundler would run them.
const evaluate = (code: string) => new Function(`return (${code});`)();

describe("toJsLiteral", () => {
  it("round-trips Date, Map, Set, BigInt, undefined and special numbers", () => {
    const value = {
      date: new Date(Date.UTC(2024, 0, 2)),
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
      big: 10n,
      missing: undefined,
      nan: Number.NaN,
      negativeZero: -0,
    };
    const result = toJsLiteral(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const back = evaluate(result.code);
    expect(back).toEqual(value);
    expect(Object.hasOwn(back, "missing")).toBe(true);
  });

  it("writes __proto__ as an own key, not the prototype", () => {
    const value = Object.fromEntries([["__proto__", { polluted: true }]]);
    const result = toJsLiteral(value);
    expect(result.ok && result.code).toContain('["__proto__"]');
    if (!result.ok) return;
    const back = evaluate(result.code);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.hasOwn(back, "__proto__")).toBe(true);
  });

  it("fails with the field path for functions, class instances and cycles", () => {
    expect(toJsLiteral({ a: [1, () => 1] })).toMatchObject({
      ok: false,
      fieldPath: ["a", 1],
    });
    expect(toJsLiteral({ url: new URL("https://x.y") })).toMatchObject({
      ok: false,
      fieldPath: ["url"],
    });
    type Cycle = { self?: Cycle };
    const cycle: Cycle = {};
    cycle.self = cycle;
    expect(toJsLiteral(cycle)).toMatchObject({
      ok: false,
      fieldPath: ["self"],
    });
  });

  it("writes shared (non-cyclic) references in full", () => {
    const shared = { x: 1 };
    const result = toJsLiteral({ a: shared, b: shared });
    expect(result.ok && evaluate(result.code)).toEqual({
      a: { x: 1 },
      b: { x: 1 },
    });
  });
});

describe("cache codec", () => {
  it("round-trips non-JSON values", () => {
    const value = {
      d: new Date(5),
      m: new Map([[1, "a"]]),
      s: new Set(["x"]),
      b: 3n,
      u: undefined,
      n: Infinity,
    };
    expect(
      decodeCacheValue(JSON.parse(JSON.stringify(encodeCacheValue(value)))),
    ).toEqual(value);
  });
});

describe("fingerprint", () => {
  it("tells RegExp, Map, Set and class instances apart", () => {
    expect(fingerprint(/a/g)).not.toBe(fingerprint(/b/g));
    expect(fingerprint(new Map([["a", 1]]))).not.toBe(
      fingerprint(new Map([["a", 2]])),
    );
    expect(fingerprint(new Set([1]))).not.toBe(fingerprint(new Set([2])));
    class Box {
      constructor(readonly value: number) {}
    }
    expect(fingerprint(new Box(1))).not.toBe(fingerprint(new Box(2)));
  });

  it("is stable for key order and treats shared references fully", () => {
    const shared = { x: 1 };
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: shared, b: shared })).toBe(
      fingerprint({ a: { x: 1 }, b: { x: 1 } }),
    );
  });
});

describe("sorting", () => {
  it("is a total order across types and puts missing values last", () => {
    expect(compareValues(1, "a")).toBeLessThan(0);
    expect(compareValues("a10", "a9")).toBeGreaterThan(0);
    const rows = sortRows([{ n: "b" }, { n: undefined }, { n: "a" }], {
      by: "n",
    });
    expect(rows.map((row) => row.n)).toEqual(["a", "b", undefined]);
  });
});
