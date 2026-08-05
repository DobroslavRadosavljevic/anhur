import {
  defineCollection,
  defineConfig,
  defineSingleton,
  schema as s,
} from "../../../src/index";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.{md,mdx}",
  schema: s.object({
    title: s.string(),
    content: s.string(),
  }),
});

const settings = defineSingleton({
  name: "settings",
  directory: "content/settings",
  include: "index.{md,mdx}",
  schema: s.object({
    title: s.string(),
    content: s.string(),
  }),
});

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content: [posts, settings],
});
