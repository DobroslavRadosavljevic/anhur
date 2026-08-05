import { defineConfig, defineSingleton, schema as s } from "../../../src/index";

export default defineConfig({
  localization: {
    strategy: "folder",
    locales: ["en", "de"],
    defaultLocale: "en",
  },
  content: [
    defineSingleton({
      name: "settings",
      directory: "content/settings",
      include: "index.md",
      schema: s.object({
        title: s.string(),
        content: s.string(),
      }),
    }),
  ],
});
