import { defineCollection, defineConfig, schema as s } from "@anhur/core";

const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "**/*.yml",
  localized: false,
  generate: { listOmit: [], split: "list-only" },
  schema: s.object({
    name: s.string(),
    role: s.string(),
  }),
});

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  localized: false,
  generate: { listOmit: [], split: "list-only" },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    author: s.reference("authors", { embed: true }),
  }),
  transform: (doc, ctx) => {
    const fromContext = ctx.documents(authors).find((a) => a.name === "Ada");
    return {
      ...doc,
      authorNameFromContext: fromContext?.name ?? null,
    };
  },
});

export default defineConfig({
  content: [authors, posts],
});
