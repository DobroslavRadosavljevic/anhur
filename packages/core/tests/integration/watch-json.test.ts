import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject,
  PACKAGE_DIR,
  type TestProject,
} from "../fixtures/temp-project";

// Failure mode: `anhur watch --json` takes the flag and prints text, so a
// tool that reads the output cannot parse it.

const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
export default defineConfig({
  content: [defineCollection({ name: "notes", directory: "notes", include: "**/*.md", schema: s.object({ title: s.string() }) })],
});
`;

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (check()) resolve();
      else if (performance.now() - started > timeoutMs)
        reject(new Error("timed out"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

describe("cli watch --json", () => {
  it("prints one line of JSON per build, for a build that fails too", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    projects.push(project);
    const cli = path.join(PACKAGE_DIR, "src/cli/main.ts");
    const child = spawn(
      "bun",
      [cli, "watch", "--root", project.dir, "--json"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const lines = () => stdout.split("\n").filter((line) => line !== "");
    try {
      await waitFor(() => lines().length === 1);
      await project.write("notes/a.md", "---\ntitle: [\n---\n");
      await waitFor(() => lines().length === 2);
      const reports: unknown[] = [];
      for (const line of lines()) {
        const report: unknown = JSON.parse(line);
        reports.push(report);
      }
      expect(reports).toMatchObject([
        { ok: true, documents: 1, diagnostics: [] },
        { ok: false, diagnostics: [{ severity: "error" }] },
      ]);
    } finally {
      child.kill();
      await once(child, "exit");
    }
  });
});
