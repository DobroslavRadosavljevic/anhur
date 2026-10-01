import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Predicate } from "effect";

function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      );
      if (
        Predicate.isObject(raw) &&
        "name" in raw &&
        raw.name === "@anhur/core" &&
        "version" in raw &&
        Predicate.isString(raw.version)
      ) {
        return raw.version;
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

/** Version of `@anhur/core` (works from `src/` and `dist/`, never throws). */
export const packageVersion: string = readVersion();
