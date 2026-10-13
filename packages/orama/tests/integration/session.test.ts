import { rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAnhur, type AnhurSession } from "@anhur/core/build";
import { createSearcher, type AnhurSearchIndex } from "../../src/client";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
const sessions: AnhurSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const project of projects.splice(0)) await project.remove();
});

const CONFIG = `
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { orama } from "@anhur/orama";

const authors = defineCollection({
  name: "authors",
  directory: "authors",
  include: "*.yml",
  localized: false,
  schema: s.object({ name: s.string() }),
});
const posts = defineCollection({
  name: "posts",
  directory: "posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    author: s.reference("authors", { embed: true }),
  }),
});

export default defineConfig({
  localization: { strategy: "folder", locales: ["en", "de"], defaultLocale: "en" },
  content: [authors, posts],
  plugins: [
    orama({
      collections: {
        posts: {
          schema: { title: "string", author: "string" },
          index: (doc) => ({ title: doc.title, author: doc.author.name }),
          store: (doc) => ({ title: doc.title }),
        },
      },
    }),
  ],
});
`;

function post(title: string, author: string, draft = false): string {
  return `---\ntitle: ${title}\nauthor: ${author}\n${draft ? "draft: true\n" : ""}---\n`;
}

type IndexModule = { readonly default: AnhurSearchIndex };

let loads = 0;

/**
 * Ids of the documents a search finds in the index a build wrote. Each
 * call imports the index module again (a new query string), so it reads
 * the file on disk and not the module of an earlier build.
 */
async function found(
  project: TestProject,
  locale: string,
  term: string,
): Promise<string[]> {
  loads += 1;
  const file = project.path(`.anhur/generated/search/${locale}.js`);
  // SAFETY: the plugin writes the index of a locale as the default export of this module.
  const module = (await import(
    `${pathToFileURL(file).href}?load=${loads}`
  )) as IndexModule;
  const searcher = await createSearcher(module.default);
  const result = await searcher.search({ term });
  return result.hits.map((hit) => hit.documentId).sort();
}

// Both modes keep indexes between builds; only `dev` keeps tokens too.
describe.each(["dev", "build"] as const)(
  "search index in a %s session",
  (mode) => {
    // Catches: an index kept from an earlier build though a document of it
    // changed (old text still found, new text not found), and tokens of an
    // earlier build used for a text they do not belong to.
    it("follows every change of the content", async () => {
      const project = await createProject({
        "anhur.config.ts": CONFIG,
        "authors/ada.yml": "name: Ada\n",
        "authors/bob.yml": "name: Bob\n",
        "posts/en/hello.md": post("Hello world", "ada"),
        "posts/en/second.md": post("Second post", "bob"),
        "posts/de/hallo.md": post("Hallo Welt", "ada"),
      });
      projects.push(project);
      const session = createAnhur({ rootDir: project.dir, mode });
      sessions.push(session);

      await session.build();
      expect(await found(project, "en", "hello")).toEqual(["hello"]);
      expect(await found(project, "en", "bob")).toEqual(["second"]);
      expect(await found(project, "de", "hallo")).toEqual(["hallo"]);

      // Edit a document.
      await project.write("posts/en/hello.md", post("Greetings planet", "ada"));
      await session.build();
      expect(await found(project, "en", "greetings")).toEqual(["hello"]);
      expect(await found(project, "en", "hello")).toEqual([]);
      expect(await found(project, "en", "second")).toEqual(["second"]);
      // The other locale did not change and is still there.
      expect(await found(project, "de", "hallo")).toEqual(["hallo"]);
      expect(await found(project, "de", "greetings")).toEqual([]);

      // Add a document.
      await project.write("posts/en/fresh.md", post("Fresh arrival", "ada"));
      await session.build();
      expect(await found(project, "en", "arrival")).toEqual(["fresh"]);
      expect(await found(project, "en", "greetings")).toEqual(["hello"]);

      // Remove a document.
      await rm(project.path("posts/en/fresh.md"));
      await session.build();
      expect(await found(project, "en", "arrival")).toEqual([]);
      expect(await found(project, "en", "greetings")).toEqual(["hello"]);

      // Rename a document: the same text, a new id.
      await rename(
        project.path("posts/en/second.md"),
        project.path("posts/en/renamed.md"),
      );
      await session.build();
      expect(await found(project, "en", "second")).toEqual(["renamed"]);

      // Make a document a draft.
      await project.write(
        "posts/en/hello.md",
        post("Greetings planet", "ada", true),
      );
      await session.build();
      expect(await found(project, "en", "greetings")).toEqual([]);
      expect(await found(project, "en", "second")).toEqual(["renamed"]);

      // Change a document that a post embeds and indexes a field of. The
      // post file did not change.
      await project.write("authors/bob.yml", "name: Robert\n");
      await session.build();
      expect(await found(project, "en", "robert")).toEqual(["renamed"]);
      expect(await found(project, "en", "bob")).toEqual([]);
      expect(await found(project, "de", "ada")).toEqual(["hallo"]);

      await project.write("authors/ada.yml", "name: Countess\n");
      await session.build();
      expect(await found(project, "de", "countess")).toEqual(["hallo"]);
      expect(await found(project, "de", "ada")).toEqual([]);
    });
  },
);
