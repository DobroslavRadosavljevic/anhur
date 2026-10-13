import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Patterns whose every character has one meaning the compiler below knows. */
const SUPPORTED_PATTERN = /^[A-Za-z0-9_\-. /*?[\]!^]+$/;
const CLASS_BODY = /^[A-Za-z0-9_\-.]+$/;
const MAX_ALTERNATIVES = 64;
/**
 * Node matches patterns without regard to case on macOS and Windows, where
 * the usual file systems do the same.
 */
const IGNORE_CASE =
  process.platform === "darwin" || process.platform === "win32";

function escapeLiteral(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Expand `{a,b}` groups (nested too). `undefined` for syntax this module
 * does not handle itself: unbalanced braces, a group without a comma (a
 * literal in glob syntax) and ranges (`{1..3}`).
 */
function expandBraces(pattern: string): string[] | undefined {
  const open = pattern.indexOf("{");
  if (open === -1) return pattern.includes("}") ? undefined : [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    } else if (char === "," && depth === 1) commas.push(index);
  }
  if (close === -1 || commas.length === 0) return undefined;
  const body = pattern.slice(open + 1, close);
  if (body.includes("..")) return undefined;
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const expanded: string[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const part = pattern.slice(bounds[index]! + 1, bounds[index + 1]);
    const nested = expandBraces(`${prefix}${part}${suffix}`);
    if (!nested) return undefined;
    expanded.push(...nested);
    if (expanded.length > MAX_ALTERNATIVES) return undefined;
  }
  return expanded;
}

/** Regular expression source of one path segment, or `undefined` when unsupported. */
function segmentSource(segment: string): string | undefined {
  if (segment === "" || segment === "." || segment === "..") return undefined;
  if (segment.includes("**")) return undefined;
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = segment.indexOf("]", index + 1);
      if (end === -1) return undefined;
      let body = segment.slice(index + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      if (
        !CLASS_BODY.test(body) ||
        body.startsWith("-") ||
        body.endsWith("-")
      ) {
        return undefined;
      }
      source += negated ? `[^/${body}]` : `[${body}]`;
      index = end;
    } else if (char === "]" || char === "!" || char === "^") {
      return undefined;
    } else source += escapeLiteral(char);
  }
  return source;
}

function patternSource(pattern: string): string | undefined {
  if (!SUPPORTED_PATTERN.test(pattern)) return undefined;
  const segments = pattern.split("/");
  let source = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const last = index === segments.length - 1;
    if (segment === "**") {
      // In the middle: any number of folders. At the end: one name or more.
      source += last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
      continue;
    }
    const part = segmentSource(segment);
    if (part === undefined) return undefined;
    source += last ? part : `${part}/`;
  }
  return source;
}

/** Tests a POSIX path relative to the folder the patterns apply to. */
export type PathMatcher = (relativePath: string) => boolean;

/**
 * Matcher for a glob pattern, with the semantics of Node's `fs.glob` /
 * `path.matchesGlob`. Plain patterns (`**`, `*`, `?`, `[a-z]`, `{a,b}`)
 * are compiled once; anything else is left to `path.matchesGlob`.
 */
export function compileGlob(pattern: string): PathMatcher {
  const alternatives = expandBraces(pattern);
  const sources = alternatives?.map((alternative) =>
    patternSource(alternative),
  );
  if (!sources || sources.includes(undefined)) {
    return (relativePath) => path.matchesGlob(relativePath, pattern);
  }
  const compiled = new RegExp(
    `^(?:${sources.join("|")})$`,
    IGNORE_CASE ? "i" : "",
  );
  return (relativePath) => compiled.test(relativePath);
}

/** What to list below a folder. */
export type ListOptions = {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Absolute folders never entered (Anhur's own output and cache). */
  readonly skip: readonly string[];
};

function isSkipped(absolute: string, skip: readonly string[]): boolean {
  return skip.some(
    (folder) => absolute === folder || absolute.startsWith(folder + path.sep),
  );
}

/** True when a symbolic link points at a file. */
async function linksToFile(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

/** A file found below a folder. */
export type ContentFile = {
  readonly absolute: string;
  /** Path below the folder, POSIX separators. */
  readonly relative: string;
};

/**
 * The files below `root` that match `include` and not `exclude`, sorted by
 * absolute path. Dotfiles, dot-folders and `node_modules` are never listed,
 * and folders behind symbolic links are not entered. Rejects when a folder
 * cannot be read.
 */
export async function listContentFiles(
  root: string,
  options: ListOptions,
): Promise<ContentFile[]> {
  const include = options.include.map(compileGlob);
  const exclude = options.exclude.map(compileGlob);
  const excluded = (relativePath: string) =>
    exclude.some((matches) => matches(relativePath));
  const found: ContentFile[] = [];

  const walk = async (folder: string, prefix: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true });
    const pending: Promise<void>[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const absolute = path.join(folder, name);
      if (entry.isDirectory()) {
        if (excluded(relativePath) || isSkipped(absolute, options.skip)) {
          continue;
        }
        pending.push(walk(absolute, relativePath));
        continue;
      }
      if (excluded(relativePath)) continue;
      if (!include.some((matches) => matches(relativePath))) continue;
      const file: ContentFile = { absolute, relative: relativePath };
      if (entry.isFile()) found.push(file);
      else if (entry.isSymbolicLink()) {
        pending.push(
          linksToFile(absolute).then((isFile) => {
            if (isFile) found.push(file);
          }),
        );
      }
    }
    await Promise.all(pending);
  };

  await walk(root, "");
  return found.sort((a, b) =>
    a.absolute < b.absolute ? -1 : a.absolute > b.absolute ? 1 : 0,
  );
}
