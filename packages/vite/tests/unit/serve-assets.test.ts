import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  matchesIfNoneMatch,
  parseRange,
  resolveAssetRequest,
  serveAssets,
  SVG_CONTENT_SECURITY_POLICY,
  type AssetRoute,
} from "../../src/serve-assets";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise((done) => server.close(done));
  for (const project of projects.splice(0)) await project.remove();
});

describe("resolveAssetRequest", () => {
  const route: AssetRoute = { dir: "/srv/assets", prefixes: ["/a/", "/app/a"] };

  it("maps prefixed URLs to files, ignoring query and hash", () => {
    expect(resolveAssetRequest(route, "/a/x-1.png?v=2#top")).toBe(
      path.resolve("/srv/assets/x-1.png"),
    );
    expect(resolveAssetRequest(route, "/app/a/sub/%C4%8D.svg")).toBe(
      path.resolve("/srv/assets/sub/č.svg"),
    );
  });

  it("rejects other prefixes, traversal, dotfiles and bad encoding", () => {
    for (const url of [
      "/b/x.png",
      "/a/",
      "/a/../secret",
      "/a/%2e%2e/secret",
      "/a/..%5csecret",
      "/a/.anhur-assets.json",
      "/a/%E0%A4%A",
    ]) {
      expect(resolveAssetRequest(route, url), url).toBeUndefined();
    }
  });
});

describe("parseRange", () => {
  it("serves single byte ranges and ignores what it does not support", () => {
    expect(parseRange("bytes=2-4", 10)).toEqual({
      kind: "partial",
      start: 2,
      end: 4,
    });
    expect(parseRange("bytes= 0-1", 10)).toEqual({
      kind: "partial",
      start: 0,
      end: 1,
    });
    expect(parseRange("bytes=-3", 10)).toEqual({
      kind: "partial",
      start: 7,
      end: 9,
    });
    expect(parseRange("bytes=5-100", 10)).toEqual({
      kind: "partial",
      start: 5,
      end: 9,
    });
    for (const ignored of [
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=5-2",
      "bytes=x",
      "bytes=-",
    ]) {
      expect(parseRange(ignored, 10), ignored).toEqual({ kind: "full" });
    }
    expect(parseRange("bytes=20-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("matchesIfNoneMatch", () => {
  it("compares weakly, in lists and with *", () => {
    expect(matchesIfNoneMatch('W/"a-1"', 'W/"a-1"')).toBe(true);
    expect(matchesIfNoneMatch('"x", W/"a-1"', 'W/"a-1"')).toBe(true);
    expect(matchesIfNoneMatch('"a-1"', 'W/"a-1"')).toBe(true);
    expect(matchesIfNoneMatch("*", 'W/"a-1"')).toBe(true);
    expect(matchesIfNoneMatch('"b-2"', 'W/"a-1"')).toBe(false);
  });
});

describe("serveAssets", () => {
  async function serve(route: AssetRoute | undefined) {
    const middleware = serveAssets(() => route);
    const server = createServer((request, response) =>
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end("next");
      }),
    );
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    // SAFETY: listen() on a TCP port gives an AddressInfo.
    const { port } = server.address() as AddressInfo;
    return (url: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${url}`, init);
  }

  it("serves files with content type, ranges, HEAD and ETags", async () => {
    const project = await createProject({
      "assets/clip.mp4": "0123456789",
      "assets/.hidden": "x",
    });
    projects.push(project);
    const request = await serve({
      dir: project.path("assets"),
      prefixes: ["/a/"],
    });

    const full = await request("/a/clip.mp4");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(await full.text()).toBe("0123456789");

    const partial = await request("/a/clip.mp4", {
      headers: { range: "bytes=2-4" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await partial.text()).toBe("234");

    const suffix = await request("/a/clip.mp4", {
      headers: { range: "bytes=-3" },
    });
    expect(await suffix.text()).toBe("789");

    const unsatisfiable = await request("/a/clip.mp4", {
      headers: { range: "bytes=20-" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");

    const head = await request("/a/clip.mp4", { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("10");

    const etag = full.headers.get("etag") ?? "";
    expect(
      (await request("/a/clip.mp4", { headers: { "if-none-match": etag } }))
        .status,
    ).toBe(304);
    for (const header of [`"other", ${etag}`, "*"]) {
      expect(
        (await request("/a/clip.mp4", { headers: { "if-none-match": header } }))
          .status,
        header,
      ).toBe(304);
    }
    for (const range of ["bytes=0-1,4-5", "items=0-1"]) {
      const ignored = await request("/a/clip.mp4", { headers: { range } });
      expect(ignored.status, range).toBe(200);
      expect(await ignored.text()).toBe("0123456789");
    }
    const spaced = await request("/a/clip.mp4", {
      headers: { range: "bytes= 0-1" },
    });
    expect(spaced.status).toBe(206);
    expect(await spaced.text()).toBe("01");
    const ifRange = await request("/a/clip.mp4", {
      headers: { range: "bytes=0-1", "if-range": '"stale"' },
    });
    expect(ifRange.status).toBe(200);
  });

  it("sends nosniff everywhere and a locked-down CSP for SVGs", async () => {
    const project = await createProject({
      "assets/logo.svg": "<svg/>",
      "assets/a.png": "x",
    });
    projects.push(project);
    const request = await serve({
      dir: project.path("assets"),
      prefixes: ["/a/"],
    });
    const svg = await request("/a/logo.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svg.headers.get("content-security-policy")).toBe(
      SVG_CONTENT_SECURITY_POLICY,
    );
    const png = await request("/a/a.png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("content-security-policy")).toBeNull();
  });

  it("passes everything else to the next handler", async () => {
    const project = await createProject({
      "assets/.hidden": "x",
      "assets/dir/file.txt": "x",
    });
    projects.push(project);
    const request = await serve({
      dir: project.path("assets"),
      prefixes: ["/a/"],
    });
    for (const url of ["/a/.hidden", "/a/dir", "/a/missing.png", "/other"]) {
      expect(await (await request(url)).text(), url).toBe("next");
    }
    expect(
      await (await request("/a/dir/file.txt", { method: "POST" })).text(),
    ).toBe("next");
    const none = await serve(undefined);
    expect((await none("/a/dir/file.txt")).status).toBe(404);
  });
});
