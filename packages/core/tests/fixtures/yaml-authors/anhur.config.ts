import {
  defineCollection,
  defineConfig,
  schema as s,
} from "../../../src/index";

const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  include: "**/*.{yml,yaml}",
  schema: s.object({
    name: s.string(),
    role: s.string(),
  }),
});

export default defineConfig({
  content: [authors],
});
