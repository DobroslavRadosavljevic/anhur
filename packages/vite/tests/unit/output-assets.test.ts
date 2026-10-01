import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { copyAssetsToOutput } from "../../src/output-assets";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function setup(files: { readonly [file: string]: string }) {
  const project = await createProject(files);
  projects.push(project);
  return project;
}

describe("copyAssetsToOutput", () => {
  it("copies only the files listed in the manifest", async () => {
    const project = await setup({
      "assets/a-0123456789abcdef.png": "A",
      "assets/leftover-0123456789abcdef.png": "old",
      "assets/.anhur-assets.json": JSON.stringify({
        files: ["a-0123456789abcdef.png", "../escape", ".hidden"],
      }),
    });
    expect(
      await copyAssetsToOutput(
        project.path("assets"),
        "/anhur-assets/",
        project.path("dist"),
      ),
    ).toBe(1);
    expect(await readdir(project.path("dist/anhur-assets"))).toEqual([
      "a-0123456789abcdef.png",
    ]);
  });

  it("copies into the output root for /, decodes the base and stays inside the output", async () => {
    const project = await setup({
      "assets/a-0123456789abcdef.png": "A",
      "assets/.tmp-file": "x",
      "dist/index.html": "app",
    });
    await copyAssetsToOutput(project.path("assets"), "/", project.path("dist"));
    expect((await readdir(project.path("dist"))).sort()).toEqual([
      "a-0123456789abcdef.png",
      "index.html",
    ]);
    await copyAssetsToOutput(
      project.path("assets"),
      "/my%20assets/",
      project.path("dist"),
    );
    expect(await readdir(project.path("dist/my assets"))).toEqual([
      "a-0123456789abcdef.png",
    ]);
    await expect(
      copyAssetsToOutput(
        project.path("assets"),
        "/../outside/",
        project.path("dist"),
      ),
    ).rejects.toThrow(/outside the build output/);
    expect(
      await copyAssetsToOutput(
        project.path("missing"),
        "/a/",
        project.path("dist"),
      ),
    ).toBe(0);
  });
});
