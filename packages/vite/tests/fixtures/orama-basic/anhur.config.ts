import { defineCollection, defineConfig } from "@anhur/core";
import { orama } from "@anhur/orama";
import * as z from "zod";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: z.object({
    title: z.string(),
    content: z.string(),
  }),
});

export default defineConfig({
  content: [posts],
  integrations: [
    orama({
      collections: {
        posts: {
          schema: {
            title: "string",
          },
          index: (doc) => ({
            title: doc.title,
          }),
          store: (doc) => ({
            title: doc.title,
            id: doc._meta.id,
          }),
        },
      },
    }),
  ],
});
