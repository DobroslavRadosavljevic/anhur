import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Predicate } from "effect";

function versionAt(file: string, name: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      Predicate.isObject(raw) &&
      "name" in raw &&
      raw.name === name &&
      "version" in raw &&
      Predicate.isString(raw.version)
    ) {
      return raw.version;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Installed version of a package as seen from `fromUrl` (pass
 * `import.meta.url`), or `"unknown"`. Put compiler versions into field
 * cache keys so upgrades invalidate cached output.
 */
export function installedVersion(name: string, fromUrl: string): string {
  const require = createRequire(fromUrl);
  try {
    const direct = versionAt(require.resolve(`${name}/package.json`), name);
    if (direct) return direct;
  } catch {
    // package.json not exported: walk up from the entry instead
  }
  try {
    let dir = dirname(require.resolve(name));
    for (let depth = 0; depth < 8; depth += 1) {
      const found = versionAt(join(dir, "package.json"), name);
      if (found) return found;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ESM-only package without a `require` export: search node_modules
  }
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 32; depth += 1) {
    const found = versionAt(
      join(dir, "node_modules", name, "package.json"),
      name,
    );
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}
