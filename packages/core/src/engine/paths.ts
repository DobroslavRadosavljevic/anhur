import path from "node:path";

/** `a\\b` → `a/b`. */
export function toPosix(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}

/** True when `child` is `parent` or inside it (absolute paths, case-sensitive). */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** True when `a` and `b` are the same path or one contains the other. */
export function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/** Path relative to `root` with POSIX separators (or the absolute path when outside). */
export function relativeTo(root: string, filePath: string): string {
  if (!isInside(filePath, root)) return toPosix(filePath);
  return toPosix(path.relative(root, filePath));
}
