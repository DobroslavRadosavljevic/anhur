import { defineCollection, defineConfig, schema as s } from "@anhur/core";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  localized: false,
  generate: { listOmit: [], split: "list-only" },
  schema: s.object({
    title: s.string(),
    slug: s.slug(),
    draft: s.boolean().optional(),
    body: s.raw(),
  }),
  transform: (doc, ctx) => {
    if (doc.slug === "manual-skip") return ctx.skip("manual");
    if (doc.slug === "from-transform-draft") {
      return { ...doc, draft: true };
    }
    return { ...doc, tagged: true };
  },
  onSuccess: async (docs) => {
    (globalThis as { __anhurOnSuccess?: number }).__anhurOnSuccess =
      docs.length;
  },
});

export default defineConfig({
  cacheDir: false,
  content: [posts],
  prepare: async (sources) => {
    const postsSource = sources.find((s) => s.name === "posts");
    if (!postsSource) return;
    for (const doc of postsSource.documents) {
      doc.prepared = true;
    }
  },
  complete: async (sources) => {
    (globalThis as { __anhurComplete?: number }).__anhurComplete =
      sources.reduce((n, s) => n + s.documents.length, 0);
  },
});
