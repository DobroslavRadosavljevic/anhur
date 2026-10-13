import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Predicate, Schema } from "effect";

/**
 * Case. Node's glob ignores case on macOS and Windows only in a segment
 * with a wildcard (`*.MD`). It compares a literal segment exactly, but an
 * include pattern still finds `Posts` for `posts` there: Node looks a
 * literal segment up with `stat`, and the usual file systems ignore case.
 * This module has one rule: on macOS and Windows every segment of an
 * include or exclude pattern ignores case.
 */
const IGNORE_CASE =
  process.platform === "darwin" || process.platform === "win32";
const MAX_ALTERNATIVES = 256;
/** `{` and `}` that are plain text while groups are expanded (private-use characters). */
const PLAIN_OPEN = "\uE000";
const PLAIN_CLOSE = "\uE001";
const BRACE_RANGE = /^(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.-?\d+)?$/;
const NON_ASCII = /[\u0080-\uffff]/;
const STAR = "[^/]*";
const NEVER = "(?!)";

/** A glob pattern this module does not match; {@link globProblem} has the reason. */
export class GlobPatternError extends Schema.TaggedError<GlobPatternError>()(
  "GlobPatternError",
  {
    pattern: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

function reject(pattern: string, reason: string): never {
  throw new GlobPatternError({
    pattern,
    reason,
    message: `Cannot use the glob pattern "${pattern}": ${reason}.`,
  });
}

/**
 * The same name can be stored composed (NFC) or decomposed (NFD, usual for
 * names made on macOS). Patterns and names are compared in NFC.
 */
function composed(text: string): string {
  return NON_ASCII.test(text) ? text.normalize("NFC") : text;
}

function escapeLiteral(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

type BraceGroup = {
  readonly pre: string;
  readonly body: string;
  readonly post: string;
};

/**
 * The first `{...}` group of `text` that has its `}`. A `{` that is never
 * closed is plain text, so the group can start after it.
 */
function firstGroup(text: string): BraceGroup | undefined {
  let open = text.indexOf("{");
  let close = text.indexOf("}", open + 1);
  if (open < 0 || close <= 0) return undefined;
  const opened: number[] = [];
  let left = text.length;
  let right: number | undefined;
  let found: readonly [number, number] | undefined;
  let index = open;
  while (index >= 0 && !found) {
    if (index === open) {
      opened.push(index);
      open = text.indexOf("{", index + 1);
    } else if (opened.length === 1) {
      found = [opened[0]!, close];
      opened.length = 0;
    } else {
      const start = opened.pop();
      if (start !== undefined && start < left) {
        left = start;
        right = close;
      }
      close = text.indexOf("}", index + 1);
    }
    index = open < close && open >= 0 ? open : close;
  }
  if (!found && opened.length > 0 && right !== undefined) {
    found = [left, right];
  }
  if (!found) return undefined;
  return {
    pre: text.slice(0, found[0]),
    body: text.slice(found[0] + 1, found[1]),
    post: text.slice(found[1] + 1),
  };
}

/** Split the body of a group at the commas that are not inside a nested group. */
function commaParts(text: string): string[] {
  if (text === "") return [""];
  const group = firstGroup(text);
  if (!group) return text.split(",");
  const parts = group.pre.split(",");
  parts[parts.length - 1] += `{${group.body}}`;
  if (group.post !== "") {
    const rest = commaParts(group.post);
    parts[parts.length - 1] += rest.shift() ?? "";
    parts.push(...rest);
  }
  return parts;
}

function expandGroups(pattern: string, text: string, top: boolean): string[] {
  const group = firstGroup(text);
  if (!group) return [text];
  const { pre, body, post } = group;
  const tails = post === "" ? [""] : expandGroups(pattern, post, false);
  // `${a,b}` is plain text.
  if (pre.endsWith("$")) return tails.map((tail) => `${pre}{${body}}${tail}`);
  if (BRACE_RANGE.test(body)) {
    reject(
      pattern,
      "ranges in braces such as {1..3} are not supported; list the values, as in {1,2,3}",
    );
  }
  if (!body.includes(",")) {
    // `{a},b}`: the first `}` is plain text and the group ends at the second.
    if (/,(?!,).*\}/.test(post)) {
      return expandGroups(
        pattern,
        `${pre}{${body}${PLAIN_CLOSE}${post}`,
        false,
      );
    }
    // `{a}` is plain text.
    return [text];
  }
  let parts = commaParts(body);
  if (parts.length === 1) {
    // `x{{a,b}}y` is `x{a}y` and `x{b}y`.
    parts = expandGroups(pattern, parts[0]!, false).map((part) => `{${part}}`);
    if (parts.length === 1) return tails.map((tail) => pre + parts[0] + tail);
  }
  const heads = parts.flatMap((part) => expandGroups(pattern, part, false));
  if (heads.length * tails.length > MAX_ALTERNATIVES) {
    reject(
      pattern,
      `the braces expand to more than ${MAX_ALTERNATIVES} patterns`,
    );
  }
  const expanded: string[] = [];
  for (const head of heads) {
    for (const tail of tails) {
      const one = pre + head + tail;
      if (!top || one !== "") expanded.push(one);
    }
  }
  return expanded;
}

/** Expand `{a,b}` groups the way Node's glob does (nested groups too). */
function expandBraces(pattern: string, text: string): string[] {
  if (!/\{(?:(?!\{).)*\}/.test(text)) return [text];
  const start = text.startsWith("{}")
    ? `${PLAIN_OPEN}${PLAIN_CLOSE}${text.slice(2)}`
    : text;
  return expandGroups(pattern, start, true).map((one) =>
    one.replaceAll(PLAIN_OPEN, "{").replaceAll(PLAIN_CLOSE, "}"),
  );
}

/** Part of a segment turned into a regular expression. */
type Piece = {
  readonly source: string;
  /** Index after the part. */
  readonly end: number;
  /** No wildcard in the part: it names one file or folder. */
  readonly literal: boolean;
};

/**
 * The class that starts with the `[` at `start`, or `undefined` when the
 * `[` is plain text (it has no `]`). `]` right after the `[` (or after
 * `[!`) is a member.
 */
function readClass(
  pattern: string,
  text: string,
  start: number,
): Piece | undefined {
  let index = start + 1;
  const negated = text[index] === "!" || text[index] === "^";
  if (negated) index += 1;
  const members: string[] = [];
  let spansSlash = false;
  let single: string | undefined;
  let rangeStart = "";
  let sawMember = false;
  let closed = false;
  const escape = (char: string) => char.replace(/[\\\][^-]/, "\\$&");
  while (index < text.length) {
    const char = text[index]!;
    if (char === "]" && sawMember) {
      closed = true;
      index += 1;
      break;
    }
    sawMember = true;
    if (char === "[" && /^\[:[a-z]+:\]/.test(text.slice(index))) {
      reject(pattern, "POSIX classes such as [[:alpha:]] are not supported");
    }
    if (rangeStart !== "") {
      if (char < rangeStart) {
        reject(
          pattern,
          `the range ${rangeStart}-${char} in a class runs backwards`,
        );
      }
      if (char === rangeStart) members.push(escape(char));
      else {
        members.push(`${escape(rangeStart)}-${escape(char)}`);
        if (rangeStart < "/" && char > "/") spansSlash = true;
      }
      rangeStart = "";
      single = undefined;
      index += 1;
    } else if (text.startsWith("-]", index + 1)) {
      members.push(`${escape(char)}\\-`);
      single = undefined;
      index += 2;
    } else if (text[index + 1] === "-") {
      rangeStart = char;
      index += 2;
    } else {
      members.push(escape(char));
      single = members.length === 1 ? char : undefined;
      index += 1;
    }
  }
  if (!closed) return undefined;
  // `[a]` is the plain letter.
  if (!negated && members.length === 1 && single !== undefined) {
    return { source: escapeLiteral(single), end: index, literal: true };
  }
  const body = members.join("");
  const source = negated
    ? `[^/${body}]`
    : `${spansSlash ? "(?!/)" : ""}[${body}]`;
  return { source, end: index, literal: false };
}

/**
 * Regular expression for the part of a segment that starts at `start`.
 * Inside a `(...)` group the part ends before `|` or `)`.
 */
function readPart(
  pattern: string,
  text: string,
  start: number,
  grouped: boolean,
): Piece {
  let source = "";
  let literal = true;
  let index = start;
  while (index < text.length) {
    const char = text[index]!;
    if (grouped && (char === "|" || char === ")")) break;
    if (text[index + 1] === "(" && "?*+@!".includes(char)) {
      if (char === "!") {
        reject(
          pattern,
          '"!(...)" is not supported; name what to leave out in "exclude"',
        );
      }
      const options: string[] = [];
      let at = index + 2;
      for (;;) {
        const option = readPart(pattern, text, at, true);
        if (option.end >= text.length) {
          reject(pattern, `the "${char}(" group has no ")"`);
        }
        options.push(option.source);
        at = option.end + 1;
        if (text[option.end] === ")") break;
      }
      source += `(?:${options.join("|")})${char === "@" ? "" : char}`;
      literal = false;
      index = at;
    } else if (char === "*") {
      // `**` inside a name is `*`.
      if (!source.endsWith(STAR)) source += STAR;
      literal = false;
      index += 1;
    } else if (char === "?") {
      source += "[^/]";
      literal = false;
      index += 1;
    } else {
      const set = char === "[" ? readClass(pattern, text, index) : undefined;
      if (set) {
        source += set.source;
        literal &&= set.literal;
        index = set.end;
      } else {
        source += escapeLiteral(char);
        index += 1;
      }
    }
  }
  return { source, end: index, literal };
}

/** One part of a pattern between two `/`. */
type Segment =
  /** `**`: any number of folders (at the end: one name or more). */
  | { readonly kind: "deep" }
  | {
      readonly kind: "name";
      /** Regular expression source for one name. */
      readonly source: string;
      /** No wildcard: the segment names one file or folder. */
      readonly literal: boolean;
    };

const DEEP: Segment = { kind: "deep" };

type Glob = {
  /** Alternatives (after `{a,b}`) that match files. */
  readonly files: readonly (readonly Segment[])[];
  /** Alternatives that end with `/` or `/.`: they match folders only. */
  readonly folders: readonly (readonly Segment[])[];
};

/**
 * Segments of one alternative: `.` and empty segments are dropped, `..`
 * removes the segment before it, neighbouring `**` become one.
 */
function readSegments(pattern: string, text: string): Segment[] {
  const names: string[] = [];
  for (const name of text.split("/")) {
    if (name === "" || name === ".") continue;
    if (name === "..") {
      const before = names.pop();
      if (before === undefined) {
        reject(pattern, 'the pattern leaves the content folder with ".."');
      }
      if (before === "**") reject(pattern, '".." after "**" is not supported');
    } else if (name !== "**" || names.at(-1) !== "**") names.push(name);
  }
  return names.map((name) => {
    if (name === "**") return DEEP;
    const part = readPart(pattern, name, 0, false);
    return { kind: "name", source: part.source, literal: part.literal };
  });
}

function readGlob(pattern: string): Glob {
  // Like Node's glob, `\` is a separator on every platform, never an escape.
  const text = pattern.normalize("NFC").replaceAll("\\", "/");
  if (text === "") reject(pattern, "the pattern is empty");
  if (text.startsWith("!") && text[1] !== "(") {
    reject(
      pattern,
      'negation with "!" is not supported; name what to leave out in "exclude"',
    );
  }
  const files = new Map<string, readonly Segment[]>();
  const folders = new Map<string, readonly Segment[]>();
  let named = false;
  for (const alternative of expandBraces(pattern, text)) {
    if (alternative.startsWith("/") || /^[A-Za-z]:\//.test(alternative)) {
      reject(
        pattern,
        "absolute paths are not supported; write the pattern relative to the content folder",
      );
    }
    const segments = readSegments(pattern, alternative);
    if (segments.length === 0) continue;
    named = true;
    const key = JSON.stringify(segments);
    // `posts/` and `posts/.` name the folder itself.
    (/(?:^|\/)\.?$/.test(alternative) ? folders : files).set(key, segments);
  }
  if (!named) {
    reject(pattern, "the pattern names the content folder itself, not files");
  }
  return { files: [...files.values()], folders: [...folders.values()] };
}

/** Regular expression source for a whole path. */
function pathSource(segments: readonly Segment[]): string {
  let source = "";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment.kind === "deep") {
      // In the middle: any number of folders. At the end: one name or more.
      source += last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
    } else source += last ? segment.source : `${segment.source}/`;
  }
  return source;
}

/** One expression for a whole name or path that matches any of `sources`. */
function anchored(sources: readonly string[]): RegExp {
  return new RegExp(
    `^(?:${[...new Set(sources)].join("|")})$`,
    IGNORE_CASE ? "i" : "",
  );
}

function toRegExp(sources: readonly string[]): RegExp | undefined {
  return sources.length === 0 ? undefined : anchored(sources);
}

/**
 * Why `pattern` cannot be used as a glob, in plain English, or `undefined`
 * when it can. Not supported: negation (`!a.md`, `!(a)`), an absolute
 * pattern, a pattern that leaves the folder with `..`, ranges in braces
 * (`{1..3}`), POSIX classes (`[[:alpha:]]`), a class range that runs
 * backwards (`[z-a]`), a `(` group without `)`.
 */
export function globProblem(pattern: string): string | undefined {
  try {
    readGlob(pattern);
    return undefined;
  } catch (cause) {
    if (cause instanceof GlobPatternError) return cause.reason;
    throw cause;
  }
}

/**
 * Source of the regular expression {@link compileGlob} tests a path with.
 * Two patterns with the same source match the same paths.
 */
export function globSource(pattern: string): string {
  return toRegExp(readGlob(pattern).files.map(pathSource))?.source ?? NEVER;
}

/** Tests a POSIX path relative to the folder the patterns apply to. */
export type PathMatcher = (relativePath: string) => boolean;

/**
 * Matcher for a glob pattern, the same on every runtime and platform.
 *
 * It follows Node's `path.matchesGlob` for `**`, `*`, `?`, `[a-z]`,
 * `[!a]`, `{a,b}` and the groups `?(a|b)`, `*(a|b)`, `+(a|b)`, `@(a|b)`,
 * with these differences:
 * - `*`, `?` and `**` also match a name that starts with a dot (the
 *   walker never lists such names);
 * - `./`, `//`, `/./` and `name/../` are removed first, `\` is `/`;
 * - pattern and path are compared in Unicode NFC form, and without
 *   regard to case on macOS and Windows (literal segments too);
 * - a pattern that ends with `/` matches folders only, so no file path.
 *
 * @throws GlobPatternError for a pattern {@link globProblem} reports.
 */
export function compileGlob(pattern: string): PathMatcher {
  const test = toRegExp(readGlob(pattern).files.map(pathSource));
  if (!test) return () => false;
  return (relativePath) => test.test(composed(relativePath));
}

/**
 * Where a folder stands in the include patterns: which files in it match
 * and which of its sub-folders can hold a match.
 */
type Stage = {
  /** Tests the name of a file in the folder (`undefined`: no name matches). */
  readonly file: RegExp | undefined;
  /** A pattern ends with `**` here: every file in the folder matches. */
  readonly everyFile: boolean;
  /** Stage of a sub-folder, `undefined` when nothing below it can match. */
  readonly enter: (name: string) => Stage | undefined;
  /** {@link Stage.enter} for a sub-folder behind a symbolic link. */
  readonly follow: (name: string) => Stage | undefined;
};

/**
 * Stage of the folder the include patterns apply to (`undefined`: no
 * pattern can match a file).
 *
 * A stage is a set of places in the patterns: "segment n of alternative m
 * comes next". A sub-folder gets the places after the segments its name
 * matches, plus every `**` place. A folder behind a symbolic link gets
 * only the places after a literal segment that names it: the link `guides`
 * is entered for `guides/*.md` (also after a `**` segment), but not for a
 * `*` segment and not by `**` itself.
 */
function includeStage(
  alternatives: readonly (readonly Segment[])[],
): Stage | undefined {
  // A place is an index into the segments of all alternatives in a row.
  const segments = alternatives.flat();
  const isLast = alternatives.flatMap((alternative) =>
    alternative.map((_, index) => index === alternative.length - 1),
  );
  const stages = new Map<string, Stage>();

  const stageOf = (places: readonly number[]): Stage | undefined => {
    const open = new Set<number>();
    const add = (place: number) => {
      if (open.has(place)) return;
      open.add(place);
      // `**` also stands for no folder at all: the next segment is open too.
      if (segments[place]!.kind === "deep" && !isLast[place]) add(place + 1);
    };
    for (const place of places) add(place);
    if (open.size === 0) return undefined;
    const key = [...open].sort((a, b) => a - b).join(",");
    const known = stages.get(key);
    if (known) return known;

    const deep: number[] = [];
    const fileSources: string[] = [];
    const folders: {
      readonly test: RegExp;
      readonly next: number;
      readonly literal: boolean;
    }[] = [];
    let everyFile = false;
    for (const place of open) {
      const segment = segments[place]!;
      if (segment.kind === "deep") {
        deep.push(place);
        if (isLast[place]) everyFile = true;
      } else if (isLast[place]) fileSources.push(segment.source);
      else {
        folders.push({
          test: anchored([segment.source]),
          next: place + 1,
          literal: segment.literal,
        });
      }
    }
    // Without folder segments every sub-folder gets the same stage.
    let below: { readonly stage: Stage | undefined } | undefined;
    const stage: Stage = {
      file: toRegExp(fileSources),
      everyFile,
      enter: (name) => {
        if (folders.length === 0) {
          below ??= { stage: stageOf(deep) };
          return below.stage;
        }
        const next = [...deep];
        for (const folder of folders) {
          if (folder.test.test(name)) next.push(folder.next);
        }
        return stageOf(next);
      },
      follow: (name) =>
        stageOf(
          folders
            .filter((folder) => folder.literal && folder.test.test(name))
            .map((folder) => folder.next),
        ),
    };
    stages.set(key, stage);
    return stage;
  };

  const starts: number[] = [];
  let place = 0;
  for (const alternative of alternatives) {
    starts.push(place);
    place += alternative.length;
  }
  return stageOf(starts);
}

/** Tests for the exclude patterns, on NFC paths below the root. */
type Excludes = {
  readonly file: PathMatcher;
  readonly folder: PathMatcher;
};

function excludeTests(patterns: readonly string[]): Excludes {
  const files: string[] = [];
  const folders: string[] = [];
  for (const pattern of patterns) {
    const glob = readGlob(pattern);
    for (const segments of glob.files) {
      files.push(pathSource(segments));
      // `drafts/**` leaves out all below `drafts`: the folder is not read.
      if (segments.length > 1 && segments.at(-1)?.kind === "deep") {
        folders.push(pathSource(segments.slice(0, -1)));
      }
    }
    for (const segments of glob.folders) folders.push(pathSource(segments));
  }
  const file = toRegExp(files);
  const folder = toRegExp([...files, ...folders]);
  return {
    file: (relativePath) => file?.test(relativePath) ?? false,
    folder: (relativePath) => folder?.test(relativePath) ?? false,
  };
}

/** What to list below a folder. */
export type ListOptions = {
  readonly include: readonly string[];
  /**
   * Patterns for files and folders to leave out. A pattern that ends with
   * `/` (`drafts/`) leaves out the folder and all below it.
   */
  readonly exclude: readonly string[];
  /** Absolute folders never entered (Anhur's own output and cache). */
  readonly skip: readonly string[];
  /**
   * Called for each folder below the root that is left out because it may
   * not be read. `reason` is a short phrase for a message.
   */
  readonly onSkip?: (folder: string, reason: string) => void;
  /** Once aborted, no more folders are read and the listing rejects. */
  readonly signal?: AbortSignal;
  /**
   * Lists the entries of a folder; `readdir` when left out. Tests pass
   * their own to see which folders are read and to make a listing fail.
   */
  readonly readFolder?: (folder: string) => Promise<Dirent[]>;
};

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder + path.sep);
}

function codeOf(cause: unknown): string | undefined {
  return Predicate.isObject(cause) &&
    "code" in cause &&
    Predicate.isString(cause.code)
    ? cause.code
    : undefined;
}

/** A folder or link that is gone, is no folder, or may not be read. */
function isMissingOrDenied(code: string | undefined): boolean {
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM"
  );
}

/**
 * What a symbolic link points at. `undefined` for a link to nothing, to
 * itself, or to something that may not be looked at; rejects for other
 * errors.
 */
async function linkTarget(
  absolute: string,
): Promise<"file" | "folder" | undefined> {
  try {
    const info = await stat(absolute);
    return info.isFile() ? "file" : info.isDirectory() ? "folder" : undefined;
  } catch (cause) {
    const code = codeOf(cause);
    if (isMissingOrDenied(code) || code === "ELOOP") return undefined;
    throw cause;
  }
}

/**
 * `prefix + name` as one flat string. An engine keeps the result of `+` as
 * two parts until the text is read; the sort of the found files by such
 * paths is slower in Bun.
 */
function flatJoin(prefix: string, name: string): string {
  return [prefix, name].join("");
}

/** A file found below a folder. */
export type ContentFile = {
  readonly absolute: string;
  /** Path below the folder, POSIX separators, names as they are on disk. */
  readonly relative: string;
};

/** How the walk came to a folder, by real paths: needed to see a loop. */
type Trail = {
  /** The root, or the last folder entered through a symbolic link. */
  readonly base: string;
  /** Real path of {@link Trail.base}. */
  readonly real: () => Promise<string>;
  /** Real folders walked before `base`: from a base down to its link. */
  readonly passed: readonly {
    readonly from: string;
    readonly to: string;
  }[];
};

/**
 * The files below `root` that match `include` and not `exclude`, sorted by
 * absolute path.
 *
 * - Dotfiles, dot-folders and `node_modules` are never listed.
 * - Only folders that can hold a match are read: `posts/*.md` reads
 *   `posts`, `*.md` reads the root.
 * - A folder behind a symbolic link is entered only when a literal segment
 *   names it (`guides/*.md`), not for a `*` or `**` segment, and never
 *   when it is the root or a folder the walk is already in.
 * - A folder below `root` that is gone or may not be read is left out
 *   (`onSkip` is called for the second case).
 *
 * @throws GlobPatternError for a pattern {@link globProblem} reports.
 * Rejects when `root` cannot be read, and for every other error of a
 * folder below it (for example too many open files).
 */
export async function listContentFiles(
  root: string,
  options: ListOptions,
): Promise<ContentFile[]> {
  const start = includeStage(
    options.include.flatMap((pattern) => readGlob(pattern).files),
  );
  const excluded = excludeTests(options.exclude);
  const { signal, skip } = options;
  const readFolder =
    options.readFolder ??
    ((folder: string) => readdir(folder, { withFileTypes: true }));
  const found: ContentFile[] = [];
  let rootReal: Promise<string> | undefined;

  // The NFC paths for the exclude tests are built only when they are needed.
  const hasExcludes = options.exclude.length > 0;
  const isOpen = (absolute: string, matchPath: string) =>
    !excluded.folder(matchPath) &&
    !skip.some((folder) => isInside(absolute, folder));

  /**
   * Enter the folder behind the link `absolute`, found in the folder
   * `parent`, unless the walk is already in that folder.
   */
  const followLink = async (
    parent: string,
    absolute: string,
    relative: string,
    matchPath: string,
    stage: Stage,
    trail: Trail,
  ): Promise<void> => {
    const [target, base] = await Promise.all([
      realpath(absolute).catch((cause: unknown) => {
        if (isMissingOrDenied(codeOf(cause))) return undefined;
        throw cause;
      }),
      trail.real(),
    ]);
    if (target === undefined) return;
    const passed = [
      ...trail.passed,
      { from: base, to: path.join(base, path.relative(trail.base, parent)) },
    ];
    const isOnPath = passed.some(
      (part) => isInside(target, part.from) && isInside(part.to, target),
    );
    if (isOnPath) return;
    await walk(absolute, relative, matchPath, stage, {
      base: absolute,
      real: async () => target,
      passed,
    });
  };

  /**
   * @param relative Path below the root, names as on disk (`""`: the root).
   * @param matchPath `relative` in NFC, for the exclude patterns.
   */
  const walk = async (
    folder: string,
    relative: string,
    matchPath: string,
    stage: Stage,
    trail: Trail,
  ): Promise<void> => {
    if (signal?.aborted) return;
    let entries: Dirent[];
    try {
      entries = await readFolder(folder);
    } catch (cause) {
      const code = codeOf(cause);
      if (relative === "" || !isMissingOrDenied(code)) throw cause;
      if (code === "EACCES" || code === "EPERM") {
        options.onSkip?.(folder, "no permission to read the folder");
      }
      return;
    }
    const pending: Promise<void>[] = [];
    const absolutePrefix = folder.endsWith(path.sep)
      ? folder
      : folder + path.sep;
    const relativePrefix = relative === "" ? "" : `${relative}/`;
    const matchPrefix = matchPath === "" ? "" : `${matchPath}/`;
    const { file, everyFile } = stage;
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      const matchName = composed(name);
      if (entry.isDirectory()) {
        const below = stage.enter(matchName);
        if (!below) continue;
        const absolute = absolutePrefix + name;
        const folderPath = hasExcludes ? matchPrefix + matchName : "";
        if (isOpen(absolute, folderPath)) {
          pending.push(
            walk(absolute, relativePrefix + name, folderPath, below, trail),
          );
        }
        continue;
      }
      const matches = everyFile || (file !== undefined && file.test(matchName));
      if (entry.isFile()) {
        if (
          matches &&
          !(hasExcludes && excluded.file(matchPrefix + matchName))
        ) {
          found.push({
            absolute: flatJoin(absolutePrefix, name),
            relative: relativePrefix + name,
          });
        }
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const below = stage.follow(matchName);
      if (!matches && !below) continue;
      const absolute = absolutePrefix + name;
      const linkPath = hasExcludes ? matchPrefix + matchName : "";
      pending.push(
        linkTarget(absolute).then(async (target) => {
          if (target === "file") {
            if (matches && !excluded.file(linkPath)) {
              found.push({ absolute, relative: relativePrefix + name });
            }
          } else if (
            target === "folder" &&
            below &&
            isOpen(absolute, linkPath)
          ) {
            await followLink(
              folder,
              absolute,
              relativePrefix + name,
              linkPath,
              below,
              trail,
            );
          }
        }),
      );
    }
    await Promise.all(pending);
  };

  if (start) {
    await walk(root, "", "", start, {
      base: root,
      real: () => (rootReal ??= realpath(root)),
      passed: [],
    });
  } else {
    // No pattern can match a file. A root that cannot be read still rejects.
    await readFolder(root);
  }
  signal?.throwIfAborted();
  return found.sort((a, b) =>
    a.absolute < b.absolute ? -1 : a.absolute > b.absolute ? 1 : 0,
  );
}
