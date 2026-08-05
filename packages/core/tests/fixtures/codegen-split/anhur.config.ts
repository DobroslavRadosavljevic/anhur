import {
  defineCollection,
  defineConfig,
  schema as s,
} from "../../../src/index";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: s.object({
    title: s.string(),
    slug: s.string(),
    body: s.string(),
  }),
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content: [posts],
});
