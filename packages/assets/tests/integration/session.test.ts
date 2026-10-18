import { readdir, rm, utimes } from "node:fs/promises";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createAnhur, type AnhurSession } from "@anhur/core/build";
import { ASSETS_MANIFEST } from "../../src";
import {
  createProject,
  PNG_1X1,
  type TestProject,
} from "../fixtures/temp-project";

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const project of projects.splice(0)) await project.remove();
});

const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { assets, schema as a } from "@anhur/assets";

const products = defineCollection({
  name: "products",
  directory: "content",
  include: "*.yml",
  schema: s.object({ cover: a.image() }),
});
export default defineConfig({ content: [products], plugins: [assets()] });
`;

const ASSETS_DIR = ".anhur/assets";

describe("assets plugin in a session", () => {
  // Catches: a session that trusts what it knows about the assets folder
  // too much: a file deleted from the folder is not copied again, a new
  // image is not copied, or the file of an image no document uses stays.
  it("keeps the assets folder right when the folder or the content changes", async () => {
    const project = await createProject({
      "anhur.config.ts": CONFIG,
      "content/img/a.png": PNG_1X1,
      "content/img/b.png": await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#0f0" },
      })
        .png()
        .toBuffer(),
      "content/kit.yml": "cover: ./img/a.png\n",
    });
    projects.push(project);
    const session = createAnhur({ rootDir: project.dir, mode: "dev" });
    sessions.push(session);
    const files = async (): Promise<string[]> => {
      const entries = await readdir(project.path(ASSETS_DIR));
      return entries.filter((entry) => entry !== ASSETS_MANIFEST).sort();
    };
    /**
     * Build until the session has seen the folder old and unchanged: from
     * then on it does not read the folder while nothing changes.
     */
    const settle = async (): Promise<void> => {
      const past = new Date(Date.now() - 60_000);
      await utimes(project.path(ASSETS_DIR), past, past);
      await session.build();
      await session.build();
    };

    await session.build();
    const first = await files();
    expect(first).toEqual([expect.stringMatching(/^a-[0-9a-f]{16}\.png$/)]);

    // A file deleted from the folder is copied again.
    await settle();
    await rm(project.path(`${ASSETS_DIR}/${first[0]}`));
    await session.build();
    expect(await files()).toEqual(first);

    // Another image: its file is copied and the unused one is removed.
    await settle();
    await project.write("content/kit.yml", "cover: ./img/b.png\n");
    await session.build();
    expect(await files()).toEqual([
      expect.stringMatching(/^b-[0-9a-f]{16}\.png$/),
    ]);
  });
});
