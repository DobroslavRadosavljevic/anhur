import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { watch, type AnhurBuildError, type BuildResult } from "../../src/build";
import {
  createProject,
  PACKAGE_DIR,
  type TestProject,
} from "../fixtures/temp-project";

const run = promisify(execFile);
const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
export default defineConfig({
  content: [defineCollection({ name: "notes", directory: "notes", include: "**/*.md", schema: s.object({ title: s.string() }) })],
});
`;

function hasStderr(value: unknown): value is { readonly stderr: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "stderr" in value &&
    typeof value.stderr === "string"
  );
}

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
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

describe("watch", () => {
  it("rebuilds on nested edits, survives errors, recovers, and never loops", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "notes/2024/deep/a.md": "---\ntitle: A\n---\n",
    });
    projects.push(project);
    const builds: BuildResult[] = [];
    const errors: AnhurBuildError[] = [];
    const controller = await watch(
      { rootDir: project.dir },
      {
        onBuild: (result) => void builds.push(result),
        onError: (error) => void errors.push(error),
      },
    );
    try {
      await waitFor(() => builds.length === 1);
      await project.write("notes/2024/deep/a.md", "---\ntitle: B\n---\n");
      await waitFor(() => builds.length === 2);
      await project.write("notes/2024/deep/a.md", "---\ntitle: [\n---\n");
      await waitFor(() => errors.length === 1);
      await project.write("notes/2024/deep/a.md", "---\ntitle: C\n---\n");
      await waitFor(() => builds.length === 3);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(builds.length).toBe(3);
      expect(await project.read(".anhur/generated/allNotes.js")).toContain(
        '"C"',
      );
    } finally {
      await controller.close();
    }
  });
});

describe("cli", () => {
  const cli = path.join(PACKAGE_DIR, "src/cli/main.ts");

  it("builds, checks and exits non-zero with formatted errors", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "notes/a.md": "---\ntitle: A\n---\n",
    });
    projects.push(project);
    const built = await run("bun", [cli, "build", "--root", project.dir]);
    expect(built.stdout).toContain("built 1 document(s)");

    const json = await run("bun", [
      cli,
      "check",
      "--root",
      project.dir,
      "--json",
    ]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, documents: 1 });

    await project.write("notes/b.md", "---\n---\n");
    const failed = await run("bun", [cli, "build", "--root", project.dir]).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failed).toMatchObject({ code: 1 });
    expect(hasStderr(failed) ? failed.stderr : "").toContain(
      "notes/b.md › title",
    );
  });
});
