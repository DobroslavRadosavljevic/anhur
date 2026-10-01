import { describe, expect, it } from "vitest";
import type { DocumentValue } from "../../src/document";
import {
  canCache,
  decodeCacheValue,
  encodeCacheValue,
} from "../../src/engine/cache-codec";
import { findNonPlainData, MAX_DEPTH } from "../../src/engine/plain-data";

function roundTrip(value: DocumentValue): DocumentValue {
  const text: string = JSON.stringify(encodeCacheValue(value));
  const parsed: unknown = JSON.parse(text);
  return decodeCacheValue(parsed);
}

describe("cache codec", () => {
  it("keeps -0, holes and objects that use the tag key", () => {
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the point of the test
    expect(roundTrip([1, , 3])).toEqual([1, undefined, 3]);
    const tricky = { "\u0000": ["d", 0] };
    expect(roundTrip(tricky)).toEqual(tricky);
  });

  it("keeps an own __proto__ key as data", () => {
    const value: { [key: string]: DocumentValue } = {};
    Object.defineProperty(value, "__proto__", {
      value: { x: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    value.y = 2;
    const decoded = roundTrip(value);
    expect(Object.keys(decoded ?? {})).toEqual(["__proto__", "y"]);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it("refuses values it cannot round-trip", () => {
    // SAFETY: deliberately not document data, to check the guard.
    expect(canCache(new URL("https://a/") as never)).toBe(false);
    expect(canCache({ when: new Date(0), tags: new Set(["a"]) })).toBe(true);
  });
});

describe("findNonPlainData", () => {
  it("names the path of class instances, functions and cycles", () => {
    // SAFETY: deliberately not document data.
    expect(
      findNonPlainData({ a: [{ b: new URL("https://a/") }] } as never),
    ).toMatchObject({
      fieldPath: ["a", 0, "b"],
    });
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    expect(findNonPlainData(cyclic)?.message).toContain("circular");
  });

  it("accepts shared objects and fails cleanly on very deep nesting", () => {
    const shared = { x: 1 };
    expect(findNonPlainData({ a: shared, b: shared })).toBeUndefined();
    let deep: DocumentValue = 1;
    for (let index = 0; index < MAX_DEPTH + 10; index += 1) deep = [deep];
    expect(findNonPlainData(deep)?.message).toContain("nested");
  });
});
