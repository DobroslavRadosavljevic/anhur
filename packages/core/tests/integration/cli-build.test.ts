import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);
const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/cli.ts",
);

describe("anhur CLI", () => {
  it("runs `anhur build` against a fixture", async () => {
    const rootDir = path.join(fixturesRoot, "hooks-drafts");
    const { stdout } = await execFileAsync(
      "bun",
      [cliPath, "build", "--root", rootDir],
      { cwd: path.join(fixturesRoot, "../..") },
    );
    expect(stdout).toMatch(/built 1 document/);
    expect(stdout).toMatch(/\.anhur\/generated/);
  });
});
