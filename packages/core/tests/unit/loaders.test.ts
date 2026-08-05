import { describe, expect, it } from "vitest";
import {
  findLoader,
  jsonLoader,
  matterLoader,
  resolveLoaders,
  yamlLoader,
} from "../../src/loaders";

describe("loaders", () => {
  it("resolves user loaders before built-ins", () => {
    const custom = {
      test: /\.md$/i,
      load: () => ({ data: { custom: true }, content: "" }),
    };
    const loaders = resolveLoaders([custom]);
    expect(findLoader("/x/post.md", loaders)).toBe(custom);
  });

  it("matter loader returns frontmatter + body", () => {
    const loaded = matterLoader().load({
      path: "/x.md",
      raw: "---\ntitle: A\n---\n\nHi\n",
    });
    expect(loaded).toEqual({
      data: { title: "A" },
      content: "Hi\n",
    });
  });

  it("yaml loader parses mappings", () => {
    const loaded = yamlLoader().load({
      path: "/a.yml",
      raw: "name: Ada\nrole: Dev\n",
    });
    expect(loaded).toEqual({
      data: { name: "Ada", role: "Dev" },
    });
  });

  it("json loader parses objects", () => {
    const loaded = jsonLoader().load({
      path: "/a.json",
      raw: '{"name":"Ada"}',
    });
    expect(loaded).toEqual({ data: { name: "Ada" } });
  });
});
