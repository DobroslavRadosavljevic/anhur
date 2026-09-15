import { describe, expect, it } from "vitest";
import { resolvePendingReferences } from "../../src/relations";
import type { ReferenceMarker } from "../../src/schema/reference";
import type { ContentMeta } from "../../src/config";
import type { DocumentFields } from "../../src/document-fields";

function meta(id: string, extras: Partial<ContentMeta> = {}): ContentMeta {
  return {
    id,
    filePath: `/${id}.md`,
    relativePath: `${id}.md`,
    extension: ".md",
    ...extras,
  };
}

function ref(collection: string, value: string, embed = true): ReferenceMarker {
  return { __anhurRef: true, collection, by: "id", embed, value };
}

describe("resolvePendingReferences", () => {
  it("resolves nested embed:true references", () => {
    const authors = {
      source: { name: "authors" },
      documents: [
        {
          data: {
            name: "Ada",
            featuredPost: ref("posts", "other"),
          },
          _meta: meta("ada"),
        },
      ],
    };
    const posts = {
      source: { name: "posts" },
      documents: [
        {
          data: {
            title: "Hello",
            author: ref("authors", "ada"),
          },
          _meta: meta("hello"),
        },
        {
          data: { title: "Other" },
          _meta: meta("other"),
        },
      ],
    };

    const failures = resolvePendingReferences([authors, posts]);
    expect(failures).toEqual([]);
    // SAFETY: preserves the existing runtime contract for this assignment.
    const author = posts.documents[0]!.data.author as DocumentFields;
    expect(author).toMatchObject({
      name: "Ada",
      featuredPost: {
        title: "Other",
        _meta: { id: "other" },
      },
    });
    expect(author.featuredPost).not.toHaveProperty("__anhurRef");
  });

  it("does not fall back to another locale when the same-locale target is missing", () => {
    const authors = {
      source: { name: "authors" },
      documents: [
        {
          data: { name: "Ada" },
          _meta: meta("ada", { locale: "en" }),
        },
      ],
    };
    const posts = {
      source: { name: "posts" },
      documents: [
        {
          data: { title: "Hallo", author: ref("authors", "ada") },
          _meta: meta("hello", { locale: "de" }),
        },
      ],
    };

    const failures = resolvePendingReferences([authors, posts]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.detail).toMatch(/locale "de"/);
  });
});
