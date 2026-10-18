import { describe, expect, it } from "vitest";
import type { DocumentFields, DocumentValue } from "../../src/document";
import { copyData } from "../../src/engine/copy-data";
import { deepFreeze } from "../../src/engine/freeze";
import { sameData } from "../../src/engine/same-data";

/**
 * `sameData` decides if the engine keeps the document object of the last
 * build. Ways it can fail:
 *
 * 1. `true` for different data: an edit never reaches the output.
 * 2. `false` for a copy of the same data: every later stage runs again.
 * 3. It never ends (or overflows the stack) on cyclic or very deep data.
 */

/** A plain object with an own `__proto__` key, as a YAML file can give. */
function withProtoKey(value: DocumentValue): DocumentFields {
  const fields: DocumentFields = { title: "t" };
  Object.defineProperty(fields, "__proto__", {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return fields;
}

/** `[1, <hole>, 3]`. */
function withHole(): DocumentValue[] {
  const list: DocumentValue[] = [1, 2, 3];
  Reflect.deleteProperty(list, 1);
  return list;
}

function sample(): DocumentFields {
  const shared = { n: 1 };
  return {
    text: "body",
    count: 3,
    big: 10n,
    on: true,
    nil: null,
    nothing: undefined,
    notANumber: Number.NaN,
    negativeZero: -0,
    when: new Date(5),
    invalid: new Date(Number.NaN),
    holes: withHole(),
    list: [1, { a: [2] }, [3]],
    map: new Map<DocumentValue, DocumentValue>([[{ k: 1 }, new Set([1])]]),
    set: new Set<DocumentValue>([1, { v: 2 }]),
    first: shared,
    second: shared,
    proto: withProtoKey({ polluted: true }),
  };
}

/** The sample with one field replaced. */
function sampleWith(key: string, value: DocumentValue): DocumentFields {
  return { ...sample(), [key]: value };
}

describe("sameData", () => {
  it("knows a copy of the data, frozen or not (failure 2)", () => {
    const data = sample();
    expect(sameData(data, copyData(data))).toBe(true);
    expect(sameData(deepFreeze(copyData(data)), data)).toBe(true);
    // An object used in two places counts by its value.
    const shared = { n: 1 };
    expect(
      sameData(
        { first: shared, second: shared },
        { first: { n: 1 }, second: { n: 1 } },
      ),
    ).toBe(true);
  });

  it.each<[string, DocumentFields]>([
    ["a string", sampleWith("text", "other")],
    ["a number", sampleWith("count", 4)],
    ["a bigint", sampleWith("big", 11n)],
    ["a number that becomes a bigint", sampleWith("count", 3n)],
    ["a boolean", sampleWith("on", false)],
    ["null that becomes undefined", sampleWith("nil", undefined)],
    ["NaN that becomes a number", sampleWith("notANumber", 0)],
    ["-0 that becomes 0", sampleWith("negativeZero", 0)],
    ["a date", sampleWith("when", new Date(6))],
    ["an invalid date that becomes valid", sampleWith("invalid", new Date(0))],
    ["a date that becomes its time", sampleWith("when", 5)],
    ["a hole that becomes undefined", sampleWith("holes", [1, undefined, 3])],
    ["a longer array", sampleWith("list", [1, { a: [2] }, [3], 4])],
    ["a value deep in an array", sampleWith("list", [1, { a: [9] }, [3]])],
    ["an array that becomes an object", sampleWith("list", { 0: 1 })],
    ["a map key", sampleWith("map", new Map([[{ k: 2 }, new Set([1])]]))],
    ["a map value", sampleWith("map", new Map([[{ k: 1 }, new Set([2])]]))],
    ["a set item", sampleWith("set", new Set([1, { v: 3 }]))],
    ["the order of a set", sampleWith("set", new Set([{ v: 2 }, 1]))],
    ["a set that becomes an array", sampleWith("set", [1, { v: 2 }])],
    ["a new key", sampleWith("extra", undefined)],
    ["one of two shared objects", sampleWith("second", { n: 2 })],
    [
      "the value of an own __proto__ key",
      sampleWith("proto", withProtoKey({ polluted: false })),
    ],
    ["an own __proto__ key that is gone", sampleWith("proto", { title: "t" })],
  ])("sees a change of %s (failure 1)", (_name, changed) => {
    expect(sameData(sample(), changed)).toBe(false);
    expect(sameData(changed, sample())).toBe(false);
  });

  it("sees a removed key and a new key order: the generated text differs (failure 1)", () => {
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(false);
    expect(sameData({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(
      sameData(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    ).toBe(false);
  });

  it("ends on cyclic data (failure 3)", () => {
    const knot = (): DocumentFields => {
      const fields: DocumentFields = { name: "knot" };
      // Two ways back: a walk without a limit doubles at every level.
      fields.left = fields;
      fields.right = fields;
      return fields;
    };
    const one = knot();
    expect(sameData(one, one)).toBe(true);
    // `true` and `false` are both right for two equal knots. It must end.
    expect([true, false]).toContain(sameData(one, knot()));
    expect(sameData(one, { name: "knot", left: one, right: null })).toBe(false);
  });

  it("ends on data nested deeper than a document can be (failure 3)", () => {
    const nested = (levels: number): DocumentValue => {
      let value: DocumentValue = "leaf";
      for (let level = 0; level < levels; level += 1) value = [value];
      return value;
    };
    expect(sameData(nested(900), nested(900))).toBe(true);
    expect(sameData(nested(900), nested(901))).toBe(false);
    // Deeper than the engine accepts: never the same, and no stack overflow.
    expect(sameData(nested(5000), nested(5000))).toBe(false);
  });

  it("compares data that is larger than the free budget (failure 1, 2)", () => {
    const large = (last: number): DocumentValue =>
      Array.from({ length: 150_000 }, (_, index) => ({
        n: index === 149_999 ? last : index,
      }));
    expect(sameData(large(1), large(1))).toBe(true);
    expect(sameData(large(1), large(2))).toBe(false);
  });
});
