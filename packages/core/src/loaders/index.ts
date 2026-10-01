import { parse as parseYaml } from "yaml";
import { isPlainObject, type DocumentFields } from "../document";
import type { LoadedFile, Loader } from "../plugin/types";

function parseYamlFields(text: string, label: string): DocumentFields {
  const value: unknown = parseYaml(text, {
    prettyErrors: true,
    uniqueKeys: true,
    merge: true,
  });
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a mapping (key: value pairs).`);
  }
  return value;
}

/** A Markdown file split into raw frontmatter text and body. */
export type FrontmatterParts = {
  readonly frontmatter: string | undefined;
  readonly body: string;
};

/** Opening fence: exactly `---`, optionally followed by a language name. */
const FENCE = /^(?:\uFEFF)?---[ \t]*([A-Za-z]*)[ \t]*\r?\n/;

const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

/** First non-blank line is a YAML `key: value` (or `key:`) line. */
function looksLikeYaml(text: string): boolean {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line !== undefined && /^[^\s:#-][^:]*:(?:[ \t]|$)/.test(line);
}

/**
 * Split `---` YAML frontmatter from the body. Frontmatter is a first line of
 * exactly `---` (`---yaml` / `---yml` also work) and a closing `---` (or
 * `...`) line. Other frontmatter languages (`---js`, `---coffee`) would
 * execute code and are rejected.
 *
 * A first line of `----` (or longer) is never frontmatter. A first `---`
 * without a closing line is a Markdown thematic break, unless the next line
 * looks like YAML (`title: …`): then the closing line is missing and that
 * is an error.
 */
export function splitFrontmatter(raw: string): FrontmatterParts {
  const plain = raw.replace(/^\uFEFF/, "");
  const open = FENCE.exec(raw);
  if (!open) return { frontmatter: undefined, body: plain };
  const language = open[1]!.toLowerCase();
  const rest = raw.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) {
    if (language === "" && !looksLikeYaml(rest)) {
      return { frontmatter: undefined, body: plain };
    }
    throw new Error("Frontmatter is not closed (missing a line with ---).");
  }
  if (language !== "" && language !== "yaml" && language !== "yml") {
    throw new Error(
      `Frontmatter language "${language}" is not supported; use YAML (---).`,
    );
  }
  const frontmatter = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  return { frontmatter, body };
}

/** YAML frontmatter + body for `.md` / `.mdx` / `.markdown`. */
export const matterLoader: Loader = {
  name: "frontmatter",
  test: /\.(?:md|mdx|markdown)$/i,
  load({ raw }): LoadedFile {
    const { frontmatter, body } = splitFrontmatter(raw);
    const data =
      frontmatter === undefined
        ? {}
        : parseYamlFields(frontmatter, "Frontmatter");
    return { data, body };
  },
};

/** Whole-file YAML. */
export const yamlLoader: Loader = {
  name: "yaml",
  test: /\.ya?ml$/i,
  load({ raw }): LoadedFile {
    return { data: parseYamlFields(raw, "YAML document") };
  },
};

/** Whole-file JSON. */
export const jsonLoader: Loader = {
  name: "json",
  test: /\.json$/i,
  load({ raw }): LoadedFile {
    const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isPlainObject(value)) {
      throw new Error("JSON document must be an object.");
    }
    return { data: value };
  },
};

export const builtinLoaders: readonly Loader[] = [
  matterLoader,
  yamlLoader,
  jsonLoader,
];

/** First loader whose `test` matches the path. */
export function findLoader(
  filePath: string,
  loaders: readonly Loader[],
): Loader | undefined {
  return loaders.find((loader) => {
    loader.test.lastIndex = 0;
    return loader.test.test(filePath);
  });
}
