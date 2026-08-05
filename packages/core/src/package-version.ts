import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version string from `@anhur/core` package.json (works from `src/` and `dist/`).
 */
export const packageVersion: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (pkg.name === "@anhur/core" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // Walk toward package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not read version from @anhur/core package.json");
})();
