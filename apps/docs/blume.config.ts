import { defineConfig } from "blume";

export default defineConfig({
  title: "Anhur",
  description:
    "Typed local content for Vite — Markdown, MDX, YAML, and JSON with Zod schemas and folder i18n.",
  logo: {
    text: "Anhur",
  },
  banner: {
    content: "Early docs — APIs may change before 1.0.",
    dismissible: true,
    id: "docs-early",
  },
  content: {
    root: "content",
  },
  theme: {
    accent: "teal",
    radius: "md",
    mode: "system",
  },
  search: {
    provider: "orama",
  },
  markdown: {
    imageZoom: true,
    code: {
      icons: true,
      wrap: false,
    },
    codeBlocks: {
      theme: {
        light: "github-light",
        dark: "github-dark",
      },
    },
  },
  ai: {
    llmsTxt: true,
  },
  seo: {
    og: { enabled: true },
    sitemap: true,
    robots: true,
    structuredData: true,
  },
  deployment: {
    output: "static",
    site: "https://anhur.dev",
  },
});
