/**
 * The declarations of a scope's output, checked by `tsc` as a consumer
 * would use them.
 *
 * Ways it can fail, each checked below:
 * - the `index.d.ts` of a scope in a nested folder imports the config from a
 *   wrong relative path (every type becomes an error or `any`);
 * - id and index key unions of a scope still name dropped documents;
 * - a `where` type predicate does not narrow the scope's document type, or
 *   narrows the main output's too;
 * - a plain boolean `where` narrows (it must keep the full, correct type);
 * - getters and lists of a scope lose their types;
 * - views of a scope claim a narrower type than the source (they keep the
 *   full one).
 */
import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../../src/build";
import { createProject, type TestProject } from "../fixtures/temp-project";

const run = promisify(execFile);
const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

function isProcessOutput(value: unknown): value is { readonly stdout: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "stdout" in value &&
    typeof value.stdout === "string"
  );
}

const CONFIG = `
import { defineCollection, defineConfig, defineIndex, schema as s } from "@anhur/core";

const items = defineCollection({
  name: "items",
  directory: "content/items",
  include: "*.md",
  localized: false,
  generate: { emitIds: true },
  schema: s.object({ title: s.string(), status: s.enum(["draft", "published"]) }),
});

const itemByTitle = defineIndex({ name: "itemByTitle", from: items, key: "title" });

export default defineConfig({
  content: [items],
  views: [itemByTitle],
  scopes: [
    {
      name: "public",
      outputDir: ".anhur/scopes/public",
      where: {
        items: (doc): doc is typeof doc & { status: "published" } => doc.status === "published",
      },
    },
    {
      name: "loose",
      outputDir: ".anhur/scopes/loose",
      where: { items: (doc) => doc.status === "published" },
    },
  ],
});
`;

const CONSUMER = `
import * as main from "./.anhur/generated/declarations";
import * as scoped from "./.anhur/scopes/public/declarations";
import * as loose from "./.anhur/scopes/loose/declarations";

// The main output keeps every document and the full types.
const mainId: main.ItemId = "wheel";
const mainStatus: "draft" | "published" = main.allItems[0]!.status;
// @ts-expect-error -- the main output has drafts: status is not only "published".
const mainNarrow: "published" = main.allItems[0]!.status;

// The scope's unions name only the kept documents.
const scopedId: scoped.ItemId = "button";
// @ts-expect-error -- "wheel" is a draft the scope dropped.
const droppedId: scoped.ItemId = "wheel";
// Views, indexes and groups keep the full document type (correct, only wider).
const byTitle: "draft" | "published" = scoped.itemByTitle.Button.status;
// @ts-expect-error -- the index of the scope has no "Wheel" key.
const droppedKey = scoped.itemByTitle.Wheel;

// The type predicate narrows the scope's documents, lists and getters.
const scopedStatus: "published" = scoped.allItems[0]!.status;
const fetched: Promise<scoped.Item | null> = scoped.getItem("button");
const fetchedStatus = async (): Promise<"published" | undefined> =>
  (await scoped.getItem("button"))?.status;

// A plain boolean filter keeps the full (correct) type.
const looseStatus: "draft" | "published" = loose.allItems[0]!.status;
// @ts-expect-error -- not narrowed without a type predicate.
const looseNarrow: "published" = loose.allItems[0]!.status;

export {
  mainId,
  mainStatus,
  mainNarrow,
  scopedId,
  droppedId,
  byTitle,
  droppedKey,
  scopedStatus,
  fetched,
  fetchedStatus,
  looseStatus,
  looseNarrow,
};
`;

describe("scope declarations", () => {
  it("type-check as a consumer uses them, with narrowed types and unions", async () => {
    const site = await createProject({
      "anhur.config.ts": CONFIG,
      "content/items/button.md": "---\ntitle: Button\nstatus: published\n---\n",
      "content/items/wheel.md": "---\ntitle: Wheel\nstatus: draft\n---\n",
    });
    projects.push(site);
    await build({ rootDir: site.dir });
    // Type-check the declarations as source (skipLibCheck would hide errors in a .d.ts).
    for (const dir of [
      ".anhur/generated",
      ".anhur/scopes/public",
      ".anhur/scopes/loose",
    ]) {
      await copyFile(
        site.path(`${dir}/index.d.ts`),
        site.path(`${dir}/declarations.ts`),
      );
    }
    await writeFile(site.path("consumer.ts"), CONSUMER);
    const output = await run(
      "bunx",
      [
        "tsc",
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--noUncheckedIndexedAccess",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2024",
        "--skipLibCheck",
        "--types",
        "node",
        "consumer.ts",
      ],
      { cwd: site.dir },
    ).then(
      () => "",
      (cause: unknown) =>
        isProcessOutput(cause) ? cause.stdout : String(cause),
    );
    expect(output).toBe("");
  }, 60_000);
});
