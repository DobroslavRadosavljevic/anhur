import { describe, expect, it } from "vitest";
import { formatAssetsStorageLogLines } from "../../src/assets-storage";

describe("formatAssetsStorageLogLines", () => {
  it("prints summary and non-empty key lists", () => {
    const lines = formatAssetsStorageLogLines({
      uploaded: ["anhur/a.png"],
      skipped: ["anhur/b.png", "anhur/c.png"],
      deleted: [],
      dryRun: false,
    });

    expect(lines[0]).toBe(
      "[anhur]   assets storage: 1 uploaded, 2 skipped, 0 deleted",
    );
    expect(lines[1]).toBe("[anhur]     uploaded (1): anhur/a.png");
    expect(lines[2]).toBe("[anhur]     skipped (2): anhur/b.png, anhur/c.png");
    expect(lines).toHaveLength(3);
  });

  it("notes dry-run and empty-emit prune skip", () => {
    const lines = formatAssetsStorageLogLines({
      uploaded: [],
      skipped: [],
      deleted: [],
      dryRun: true,
      pruneSkipped: "empty-emit",
    });

    expect(lines).toEqual([
      "[anhur]   assets storage: 0 uploaded, 0 skipped, 0 deleted, dry-run, prune skipped (no assets emitted)",
    ]);
  });

  it("truncates long key lists", () => {
    const skipped = Array.from({ length: 45 }, (_, i) => `anhur/f-${i}.png`);
    const lines = formatAssetsStorageLogLines(
      {
        uploaded: [],
        skipped,
        deleted: ["anhur/old.png"],
        dryRun: false,
      },
      { maxKeys: 40 },
    );

    expect(lines[1]).toContain("skipped (45):");
    expect(lines[1]).toContain("… +5 more");
    expect(lines[2]).toBe("[anhur]     deleted (1): anhur/old.png");
  });

  it("supports a custom line prefix for the CLI", () => {
    const lines = formatAssetsStorageLogLines(
      {
        uploaded: ["x.png"],
        skipped: [],
        deleted: [],
        dryRun: false,
      },
      { prefix: "anhur:   " },
    );

    expect(lines[0]).toBe(
      "anhur:   assets storage: 1 uploaded, 0 skipped, 0 deleted",
    );
    expect(lines[1]).toBe("anhur:     uploaded (1): x.png");
  });
});
