import { describe, expect, it } from "vitest";
import type { DocumentFields, DocumentValue } from "../../src/document";
import { deepFreeze, isDeepFrozen } from "../../src/engine/freeze";
import { toJsLiteral } from "../../src/engine/serialize";

/**
 * Documents live for a whole session, so `deepFreeze` must leave nothing
 * that user code can change. Ways it can fail:
 *
 * 1. It trusts a container that someone else froze (Zod freezes
 *    `.readonly()` output one level deep) and leaves what is below it open.
 * 2. It cannot lock a `Map`, `Set` or `Date` that someone else froze, and
 *    gives the value back with that instance still open.
 * 3. It calls a value deep-frozen that is not, so something remembered by
 *    the identity of the value goes stale.
 * 4. It never ends on a cycle through a container that someone else froze.
 */

/** The methods of `value` that change it must throw. */
function expectLocked(value: DocumentValue): void {
  if (value instanceof Date) {
    expect(() => value.setTime(1)).toThrow(TypeError);
  } else if (value instanceof Map) {
    expect(() => value.set("x", 1)).toThrow(TypeError);
  } else if (value instanceof Set) {
    expect(() => value.add("x")).toThrow(TypeError);
  } else {
    throw new Error("fixture: not a Date, Map or Set");
  }
}

describe("deepFreeze", () => {
  it("freezes what is below a container that someone else froze (failure 1)", () => {
    const item = { n: 1 };
    const when = new Date(5);
    const map = new Map([["a", { n: 1 }]]);
    const set = new Set(["a"]);
    // What Zod gives for `z.array(...).readonly()` and `z.object(...).readonly()`.
    const list = Object.freeze([item]);
    const box = Object.freeze({ when, map, set, inner: { list: [1] } });
    const data = deepFreeze({ title: "t", list, box });

    expect(data.list).toBe(list);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(box.inner.list)).toBe(true);
    expect(Object.isFrozen(map.get("a"))).toBe(true);
    expectLocked(when);
    expectLocked(map);
    expectLocked(set);
    expect(when.getTime()).toBe(5);
    expect(isDeepFrozen(list)).toBe(true);
    expect(isDeepFrozen(box)).toBe(true);
  });

  it("freezes a root that someone else froze, in place (failure 1)", () => {
    const root = Object.freeze({ list: [{ n: 1 }] });
    expect(deepFreeze(root)).toBe(root);
    expect(Object.isFrozen(root.list[0])).toBe(true);
  });

  it.each<[string, () => DocumentValue]>([
    ["Date", () => new Date(5)],
    ["Map", () => new Map([["a", 1]])],
    ["Set", () => new Set(["a"])],
  ])(
    "gives a locked copy for a %s that someone else froze (failure 2)",
    (_kind, make) => {
      // What Zod gives for `z.date().readonly()`: frozen, and `setTime` works.
      const open = Object.freeze(make());
      const data = { title: "t", nested: [{ value: open }] };
      const frozen = deepFreeze(data);

      expect(frozen).not.toBe(data);
      expect(frozen).toEqual(data);
      expectLocked(frozen.nested[0]?.value);
      expect(Object.isFrozen(frozen.nested)).toBe(true);
      expect(isDeepFrozen(frozen)).toBe(true);
      // The value given in still holds the open instance: it is not known as done.
      expect(isDeepFrozen(data)).toBe(false);
      expect(isDeepFrozen(data.nested)).toBe(false);
    },
  );

  it("gives a copy every time for an object shared by many documents (failure 2, 3)", () => {
    // A constant a transform puts into every document it returns.
    const shared = { stamp: Object.freeze(new Date(5)) };
    const first = deepFreeze({ id: 1, shared });
    const second = deepFreeze({ id: 2, shared });
    expectLocked(first.shared.stamp);
    expectLocked(second.shared.stamp);
    expect(second.shared).not.toBe(shared);
  });

  it("does not call a value deep-frozen that it did not finish (failure 3)", () => {
    const shallow = Object.freeze({ _meta: { id: "a" }, tags: ["x"] });
    expect(isDeepFrozen(shallow)).toBe(false);
    // The literal of such an object is not remembered: a change must show.
    expect(toJsLiteral(shallow)).toMatchObject({
      code: '{"_meta":{"id":"a"},"tags":["x"]}',
    });
    shallow.tags.push("y");
    expect(toJsLiteral(shallow)).toMatchObject({
      code: '{"_meta":{"id":"a"},"tags":["x","y"]}',
    });
    expect(isDeepFrozen(deepFreeze(shallow))).toBe(true);
    expect(isDeepFrozen("text")).toBe(true);
  });

  it("ends on a cycle through a container that someone else froze (failure 4)", () => {
    const inner: DocumentFields = {};
    const outer = Object.freeze({ inner });
    inner.outer = outer;
    expect(deepFreeze(outer)).toBe(outer);
    expect(Object.isFrozen(inner)).toBe(true);
  });

  it("leaves data it cannot copy to the stage that reports it (failure 2)", () => {
    const data: DocumentFields = { when: Object.freeze(new Date(5)) };
    // Not document data: a `prepare` hook can add it all the same.
    Reflect.set(data, "run", () => 1);
    expect(deepFreeze(data)).toBe(data);
    expect(isDeepFrozen(data)).toBe(false);
    expect(toJsLiteral(data)).toMatchObject({ ok: false, fieldPath: ["run"] });
  });
});

describe("toJsLiteral", () => {
  it("has the same depth limit with and without a remembered literal", () => {
    let deep: DocumentFields = { leaf: true };
    for (let level = 0; level < 990; level += 1) deep = { d: deep };
    const inner = deepFreeze({ _meta: { id: "inner" }, deep });
    let outer: DocumentValue = inner;
    for (let level = 0; level < 20; level += 1) outer = { o: outer };

    const cold = toJsLiteral(outer);
    expect(cold).toMatchObject({ ok: false });
    // Alone the document is not too deep, and its literal is remembered.
    expect(toJsLiteral(inner)).toMatchObject({ ok: true });
    expect(toJsLiteral(outer)).toEqual(cold);
    // Where it fits, the remembered literal is used.
    const fits = toJsLiteral({ o: inner });
    expect(fits).toMatchObject({ ok: true });
  });
});
