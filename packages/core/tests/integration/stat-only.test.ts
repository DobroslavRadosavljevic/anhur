import { utimes } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, createAnhur, type AnhurSession } from "../../src/build";
import { COUNTING, count, makeOld, resetCounts } from "../fixtures/counting";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
beforeEach(resetCounts);
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const project of projects.splice(0)) await project.remove();
});

const NOTES = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
${COUNTING}
const upper = defineField(s.string(), {
  kind: "upper",
  whenAbsent: "skip",
  pure: true,
  compile: (input) => {
    bump("compile");
    return String(input).toUpperCase();
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ title: upper }),
});
export default defineConfig({ content: [notes] });
`;

async function notesProject(): Promise<TestProject> {
  const dir = await createProject({
    "anhur.config.ts": NOTES,
    "notes/a.md": "---\ntitle: a\n---\n",
    "notes/b.md": "---\ntitle: b\n---\n",
  });
  projects.push(dir);
  return dir;
}

// Failure these catch: the engine promises one `stat` for an unchanged
// file, but reads and hashes it. The output is the same either way, so the
// tests read `result.reuse`, which says how each document was made.
describe("an unchanged file is not read", () => {
  it("in a rebuild of a session", async () => {
    const dir = await notesProject();
    await makeOld(dir, "notes/a.md", "notes/b.md");
    const session = createAnhur({ rootDir: dir.dir });
    sessions.push(session);
    const first = await session.build();
    expect(first.reuse).toEqual({ unchanged: 0, compared: 0, validated: 2 });
    resetCounts();
    const again = await session.build();
    expect(again.reuse).toEqual({ unchanged: 2, compared: 0, validated: 0 });
    expect(count("compile")).toBe(0);
  });

  it("in a new session", async () => {
    const dir = await notesProject();
    await makeOld(dir, "notes/a.md", "notes/b.md");
    await build({ rootDir: dir.dir });
    resetCounts();
    const again = await build({ rootDir: dir.dir });
    expect(again.reuse).toEqual({ unchanged: 2, compared: 0, validated: 0 });
    expect(count("compile")).toBe(0);
  });

  it("but a file changed in the last seconds is compared by content", async () => {
    // Failure: two saves in one time step of the file system leave the
    // size and times the same; trusting them would miss the second save.
    const dir = await notesProject();
    await makeOld(dir, "notes/a.md");
    const session = createAnhur({ rootDir: dir.dir });
    sessions.push(session);
    await session.build();
    // b.md was written just before the first build; a.md is old.
    const again = await session.build();
    expect(again.reuse).toEqual({ unchanged: 1, compared: 1, validated: 0 });
    expect(count("compile")).toBe(2);
  });

  it("after a checkout gave it new times: read once, then not again", async () => {
    // Failure: the new times were only remembered in memory, so every
    // later session read and hashed the file again.
    const dir = await notesProject();
    await makeOld(dir, "notes/a.md", "notes/b.md");
    await build({ rootDir: dir.dir });
    const later = new Date(Date.now() - 30_000);
    await utimes(dir.path("notes/a.md"), later, later);
    resetCounts();
    const second = await build({ rootDir: dir.dir });
    expect(second.reuse).toEqual({ unchanged: 1, compared: 1, validated: 0 });
    const third = await build({ rootDir: dir.dir });
    expect(third.reuse).toEqual({ unchanged: 2, compared: 0, validated: 0 });
    expect(count("compile")).toBe(0);
  });

  it("and a dry run counts the same way", async () => {
    const dir = await notesProject();
    await makeOld(dir, "notes/a.md", "notes/b.md");
    await build({ rootDir: dir.dir });
    const session = createAnhur({ rootDir: dir.dir });
    sessions.push(session);
    const checked = await session.build({ dryRun: true });
    expect(checked.reuse).toEqual({ unchanged: 2, compared: 0, validated: 0 });
  });
});
