import path from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import anhur from "@anhur/vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");

const workspacePackages = [
  "@anhur/assets",
  "@anhur/core",
  "@anhur/mdx",
  "@anhur/markdown",
  "@anhur/orama",
  "@anhur/vite",
];

export default defineConfig({
  server: {
    port: 3000,
    fs: {
      // Workspace packages live outside the app root
      allow: [repoRoot],
    },
  },
  resolve: {
    alias: {
      "~": path.resolve(appRoot, "src"),
      "anhur/generated": path.resolve(appRoot, ".anhur/generated"),
    },
    dedupe: ["react", "react-dom"],
  },
  // Compile workspace TypeScript in-graph so edits hot-reload without tsdown
  optimizeDeps: {
    exclude: workspacePackages,
  },
  ssr: {
    noExternal: workspacePackages,
  },
  plugins: [
    anhur(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
    }),
    viteReact(),
    nitro(),
  ],
});
