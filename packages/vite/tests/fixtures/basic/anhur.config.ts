import { defineCollection, defineConfig } from "@anhur/core";
import * as z from "zod";

export default defineConfig({
  content: [
    defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: z.object({
        title: z.string(),
        content: z.string(),
      }),
    }),
  ],
});
