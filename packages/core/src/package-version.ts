import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PackageJsonSchema = z.object({
  name: z.string().optional(),
  version: z.string(),
});

/**
 * Version string from `@anhur/core` package.json (works from `src/` and `dist/`).
 */
export const packageVersion: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const parsed = PackageJsonSchema.safeParse(
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
      );
      if (parsed.success && parsed.data.name === "@anhur/core") {
        return parsed.data.version;
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
