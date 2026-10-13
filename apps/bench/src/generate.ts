import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** What a generated project holds. */
export type FixtureSummary = {
  readonly documents: number;
  readonly posts: number;
  readonly pages: number;
  readonly products: number;
  readonly authors: number;
  readonly images: number;
};

const LOCALES = ["en", "de"] as const;

const WORDS = [
  "content",
  "schema",
  "build",
  "module",
  "render",
  "cache",
  "locale",
  "static",
  "typed",
  "query",
  "import",
  "asset",
  "image",
  "markdown",
  "editor",
  "deploy",
  "preview",
  "section",
  "author",
  "release",
  "pipeline",
  "search",
  "index",
  "field",
  "validate",
  "document",
  "collection",
  "straße",
  "größe",
  "über",
];

const TAGS = ["guide", "news", "release", "howto", "deep-dive", "notes"];
const CATEGORIES = ["tools", "kits", "books", "parts", "apparel"];

/** Deterministic PRNG, so two runs benchmark the same content. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = {
  readonly int: (max: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
};

function createRandom(seed: number): Random {
  const next = mulberry32(seed);
  const int = (max: number) => Math.floor(next() * max);
  return {
    int,
    pick: (items) => items[int(items.length)]!,
  };
}

function sentence(random: Random, words: number): string {
  const parts: string[] = [];
  for (let index = 0; index < words; index += 1) {
    parts.push(random.pick(WORDS));
  }
  const text = parts.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(random: Random): string {
  const sentences: string[] = [];
  const count = 3 + random.int(4);
  for (let index = 0; index < count; index += 1) {
    sentences.push(sentence(random, 8 + random.int(10)));
  }
  return sentences.join(" ");
}

/** Markdown body with headings, lists, a table, code and links. */
function markdownBody(random: Random, image: string | undefined): string {
  const blocks: string[] = [paragraph(random)];
  const sections = 3 + random.int(3);
  for (let section = 0; section < sections; section += 1) {
    blocks.push(`## ${sentence(random, 3).slice(0, -1)} ${section + 1}`);
    blocks.push(paragraph(random));
    blocks.push(
      `Read the [${random.pick(WORDS)} docs](https://example.com/docs/${random.pick(WORDS)}) and **${random.pick(WORDS)}** with \`${random.pick(WORDS)}()\`.`,
    );
    if (section % 2 === 0) {
      blocks.push(`### ${sentence(random, 2).slice(0, -1)} details`);
      blocks.push(
        [1, 2, 3, 4]
          .map((item) => `- ${sentence(random, 5 + item)}`)
          .join("\n"),
      );
    } else {
      blocks.push(
        [
          "```ts",
          `export const ${random.pick(WORDS)} = ${random.int(1000)};`,
          `export function ${random.pick(WORDS)}(input: string) {`,
          "  return input.trim();",
          "}",
          "```",
        ].join("\n"),
      );
    }
    blocks.push(paragraph(random));
  }
  blocks.push(
    [
      "| Name | Value |",
      "| --- | --- |",
      `| ${random.pick(WORDS)} | ${random.int(100)} |`,
      `| ${random.pick(WORDS)} | ${random.int(100)} |`,
    ].join("\n"),
  );
  if (image !== undefined) blocks.push(`![${random.pick(WORDS)}](${image})`);
  blocks.push(paragraph(random));
  return blocks.join("\n\n");
}

async function writeImage(
  file: string,
  index: number,
  width: number,
  height: number,
): Promise<void> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: {
        r: (index * 37) % 256,
        g: (index * 91) % 256,
        b: (index * 17) % 256,
      },
    },
  })
    .png()
    .toBuffer();
  await writeFile(file, buffer);
}

async function inBatches(
  tasks: readonly (() => Promise<void>)[],
  size: number,
): Promise<void> {
  for (let start = 0; start < tasks.length; start += size) {
    await Promise.all(tasks.slice(start, start + size).map((task) => task()));
  }
}

/**
 * Write a content project with about `total` documents into `dir`:
 * 60% MDX posts and 20% Markdown pages (both in `en` / `de`), 20% JSON
 * products, plus YAML authors and one image per four documents.
 */
export async function generateFixture(
  dir: string,
  total: number,
): Promise<FixtureSummary> {
  const random = createRandom(total);
  const posts = Math.floor(total * 0.6);
  const pages = Math.floor(total * 0.2);
  const products = total - posts - pages;
  const authors = Math.min(200, Math.max(5, Math.floor(total / 50)));
  const images = Math.max(8, Math.floor(total / 4));
  const content = path.join(dir, "content");
  const folders = [
    "authors",
    "media",
    "products",
    ...LOCALES.flatMap((locale) => [`posts/${locale}`, `pages/${locale}`]),
  ];
  await Promise.all(
    folders.map((folder) =>
      mkdir(path.join(content, folder), { recursive: true }),
    ),
  );

  const tasks: (() => Promise<void>)[] = [];
  for (let index = 0; index < images; index += 1) {
    tasks.push(() =>
      writeImage(
        path.join(content, "media", `image-${index}.png`),
        index,
        320 + (index % 5) * 64,
        180 + (index % 3) * 60,
      ),
    );
  }
  for (let index = 0; index < authors; index += 1) {
    tasks.push(() =>
      writeFile(
        path.join(content, "authors", `author-${index}.yml`),
        [
          `name: Author ${index}`,
          `role: ${random.pick(["Editor", "Engineer", "Writer"])}`,
          `bio: ${sentence(random, 14)}`,
          `avatar: ../media/image-${index % images}.png`,
          "",
        ].join("\n"),
      ),
    );
  }
  for (let index = 0; index < posts; index += 1) {
    const locale = LOCALES[index % LOCALES.length]!;
    const image = `../../media/image-${index % images}.png`;
    const tags = [random.pick(TAGS), random.pick(TAGS)];
    const day = String(1 + (index % 28)).padStart(2, "0");
    const month = String(1 + (index % 12)).padStart(2, "0");
    const frontmatter = [
      "---",
      `title: ${sentence(random, 5).slice(0, -1)} ${index}`,
      `summary: ${sentence(random, 12)}`,
      `publishedAt: ${2020 + (index % 6)}-${month}-${day}`,
      `tags: [${[...new Set(tags)].join(", ")}]`,
      `author: author-${index % authors}`,
      `cover: ${image}`,
      "---",
      "",
    ].join("\n");
    const body = markdownBody(random, index % 5 === 0 ? image : undefined);
    const note = `\n\n<aside>\n\n${sentence(random, 9)} {1 + ${index % 9}}\n\n</aside>\n`;
    tasks.push(() =>
      writeFile(
        path.join(content, "posts", locale, `post-${index}.mdx`),
        `${frontmatter}${body}${note}`,
      ),
    );
  }
  for (let index = 0; index < pages; index += 1) {
    const locale = LOCALES[index % LOCALES.length]!;
    const frontmatter = [
      "---",
      `title: ${sentence(random, 4).slice(0, -1)} ${index}`,
      "---",
      "",
    ].join("\n");
    const body = markdownBody(random, undefined);
    tasks.push(() =>
      writeFile(
        path.join(content, "pages", locale, `page-${index}.md`),
        `${frontmatter}${body}\n`,
      ),
    );
  }
  for (let index = 0; index < products; index += 1) {
    const product = {
      name: `${random.pick(WORDS)} ${index}`,
      sku: `SKU-${String(index).padStart(6, "0")}`,
      price: 5 + random.int(500),
      featured: index % 7 === 0,
      category: random.pick(CATEGORIES),
    };
    tasks.push(() =>
      writeFile(
        path.join(content, "products", `product-${index}.json`),
        `${JSON.stringify(product, null, 2)}\n`,
      ),
    );
  }
  await inBatches(tasks, 64);
  return {
    documents: posts + pages + products + authors,
    posts,
    pages,
    products,
    authors,
    images,
  };
}
