import { describe, expect, it } from "vitest";
import { fingerprintCacheValue } from "../../src/cache-fingerprint";

function pluginAlpha() {
  return () => undefined;
}

function pluginBeta() {
  return () => undefined;
}

describe("fingerprintCacheValue", () => {
  it("distinguishes different named plugins at the same list length", () => {
    expect(fingerprintCacheValue([pluginAlpha])).not.toEqual(
      fingerprintCacheValue([pluginBeta]),
    );
  });

  it("includes unified tuple options so option changes invalidate", () => {
    expect(
      fingerprintCacheValue([[pluginAlpha, { marker: "ONE" }]]),
    ).not.toEqual(fingerprintCacheValue([[pluginAlpha, { marker: "TWO" }]]));
    expect(fingerprintCacheValue([[pluginAlpha, { marker: "ONE" }]])).toEqual(
      fingerprintCacheValue([[pluginAlpha, { marker: "ONE" }]]),
    );
  });

  it("is JSON-serializable", () => {
    const snap = fingerprintCacheValue({
      source: "hi",
      plugins: [[pluginAlpha, { n: 1 }]],
    });
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(JSON.stringify(snap)).toContain("pluginAlpha");
  });
});
