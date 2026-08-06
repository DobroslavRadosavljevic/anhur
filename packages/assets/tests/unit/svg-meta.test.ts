import { describe, expect, it } from "vitest";
import { parseSvgSize } from "../../src/svg-meta";

describe("parseSvgSize", () => {
  it("reads numeric width and height", () => {
    expect(
      parseSvgSize(
        `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect/></svg>`,
      ),
    ).toEqual({ width: 100, height: 50 });
  });

  it("reads width/height with units", () => {
    expect(
      parseSvgSize(
        `<svg width="64px" height="32px" xmlns="http://www.w3.org/2000/svg"></svg>`,
      ),
    ).toEqual({ width: 64, height: 32 });
  });

  it("falls back to viewBox when size attrs are missing", () => {
    expect(
      parseSvgSize(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><circle/></svg>`,
      ),
    ).toEqual({ width: 200, height: 100 });
  });

  it("ignores percentage width/height and uses viewBox", () => {
    expect(
      parseSvgSize(
        `<svg width="100%" height="100%" viewBox="0 0 80 40" xmlns="http://www.w3.org/2000/svg"></svg>`,
      ),
    ).toEqual({ width: 80, height: 40 });
  });

  it("returns zeros when no usable size is present", () => {
    expect(
      parseSvgSize(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
    ).toEqual({ width: 0, height: 0 });
  });
});
