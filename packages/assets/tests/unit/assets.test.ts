import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetRef } from "@anhur/core/plugin";
import {
  ASSETS_MANIFEST,
  copyAssets,
  parseSvgSize,
  pruneAssets,
  pruneStorage,
  readImageMeta,
  sanitizeSvg,
  SVG_SANITIZER_VERSION,
  syncStorage,
  type AssetStorageClient,
} from "../../src";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

async function project() {
  const created = await createProject({});
  projects.push(created);
  return created;
}

/** Asset hash as core computes it (see `AssetHost.transformVersion`). */
function hashOf(contents: string | Uint8Array, version?: string): string {
  const hash = createHash("sha256");
  if (version !== undefined) hash.update(`${version}\0`);
  return hash.update(contents).digest("hex").slice(0, 16);
}

function assetRef(
  sourcePath: string,
  contents: string | Uint8Array,
  options: { readonly stem?: string; readonly svg?: boolean } = {},
): AssetRef {
  const extension = options.svg ? ".svg" : ".png";
  const hash = hashOf(
    contents,
    options.svg ? SVG_SANITIZER_VERSION : undefined,
  );
  const fileName = `${options.stem ?? "a"}-${hash}${extension}`;
  return {
    src: `/a/${fileName}`,
    sourcePath,
    fileName,
    hash,
    size: Buffer.byteLength(contents),
    contentType: options.svg ? "image/svg+xml" : "image/png",
  };
}

describe("image metadata", () => {
  it("applies EXIF orientation and reports the real blur size", async () => {
    const dir = await project();
    const file = dir.path("portrait.jpg");
    await mkdir(dir.dir, { recursive: true });
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: "#f00" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(file);
    const meta = await readImageMeta(file, { blur: true });
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect([meta.blurWidth, meta.blurHeight]).toEqual([4, 8]);

    const wide = dir.path("wide.png");
    await sharp({
      create: { width: 400, height: 100, channels: 3, background: "#00f" },
    })
      .png()
      .toFile(wide);
    const wideMeta = await readImageMeta(wide, { blur: true });
    expect([wideMeta.blurWidth, wideMeta.blurHeight]).toEqual([8, 2]);
  });

  it("explains unreadable images and formats without a size reader", async () => {
    const dir = await project();
    await dir.write("broken.png", "not an image");
    await expect(
      readImageMeta(dir.path("broken.png"), { blur: true }),
    ).rejects.toThrow(/cannot read the image/);
    await dir.write("favicon.ico", "ico");
    await expect(
      readImageMeta(dir.path("favicon.ico"), { blur: true }),
    ).rejects.toThrow(/cannot read the size of "\.ico" files/);
  });
});

describe("parseSvgSize", () => {
  it("reads sizes like browsers", () => {
    expect(
      parseSvgSize('<svg stroke-width="2" width="200" viewBox="0 0 100 50"/>'),
    ).toEqual({ width: 200, height: 100 });
    expect(
      parseSvgSize(
        '<!-- <svg width="1" height="1"> --><svg width="1in" height="48pt"/>',
      ),
    ).toEqual({ width: 96, height: 64 });
    expect(parseSvgSize('<svg width="10em" height="50%"/>')).toBeUndefined();
  });

  it("keeps sizes whole, at least 1 and finite", () => {
    expect(parseSvgSize('<svg width="0.4" height="0.4"/>')).toEqual({
      width: 1,
      height: 1,
    });
    expect(
      parseSvgSize('<svg width="100" viewBox="0 0 1e-300 1"/>'),
    ).toBeUndefined();
    expect(parseSvgSize('<svg width="1e400" height="10"/>')).toBeUndefined();
  });

  it("reads attributes with a real parser", () => {
    expect(
      parseSvgSize('<svg aria-label="a>b" width="3" height="4"/>'),
    ).toEqual({ width: 3, height: 4 });
    expect(() => parseSvgSize('<svg width="1"')).toThrow(/not well-formed/);
    expect(() => parseSvgSize("<html/>")).toThrow(/not an SVG/);
  });
});

describe("sanitizeSvg", () => {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const SVG = 'xmlns="http://www.w3.org/2000/svg"';
  const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';

  it("keeps drawing markup and drops scripts, handlers and javascript links", () => {
    expect(
      sanitizeSvg(
        '<svg onload="x()"><script>alert(1)</script><foreignObject><div/></foreignObject><a href="javascript:alert(1)"><rect onclick=\'y()\' width="2"/></a></svg>',
      ),
    ).toBe(`<svg ${SVG}><a><rect width="2"/></a></svg>`);
    const drawing = `<svg ${SVG} ${XLINK} viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><g fill="url(#g)"><path d="M0 0h10"/><use xlink:href="#g" x="1"/><text x="1">a &amp; b</text></g></svg>`;
    expect(sanitizeSvg(drawing)).toBe(drawing);
  });

  it("is not fooled by markup tricks, namespaces, entities or animations", () => {
    const attacks = [
      `<svg ${SVG}><s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>`,
      `<svg ${SVG}><h:script xmlns:h="${XHTML}">alert(1)</h:script></svg>`,
      `<svg ${SVG}><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>`,
      `<svg ${SVG} ${XLINK}><a xlink:href="java&#9;script:alert(1)">x</a></svg>`,
      `<svg ${SVG}><a href=" JAVASCRIPT:alert(1)">x</a></svg>`,
      `<svg ${SVG}><a><animate attributeName="href" values="javascript:alert(1)"/>x</a></svg>`,
      `<svg ${SVG}><a><set attributeName="xlink:href" to="javascript:alert(1)"/>x</a></svg>`,
      `<svg ${SVG}><rect><set attributeName="onclick" to="alert(1)"/></rect></svg>`,
      `<svg ${SVG}><use href="data:image/svg+xml;base64,PHN2Zy8+#x"/></svg>`,
      `<svg ${SVG}><iframe xmlns="${XHTML}" src="javascript:alert(1)"/><embed xmlns="${XHTML}" src="x.swf"/></svg>`,
      `<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><body xmlns="${XHTML}"><script>alert(1)</script></body></s:foreignObject></s:svg>`,
      `<svg ${SVG}><!-- <script>alert(1)</script> --><g xml:base="javascript:/" style="fill:red"/></svg>`,
    ];
    for (const attack of attacks) {
      const clean = sanitizeSvg(attack);
      expect(clean, attack).not.toMatch(
        /script|javascript|onclick|iframe|embed|foreignObject|data:image\/svg|xml:base|<!--/i,
      );
      expect(() => parseSvgSize(clean), attack).not.toThrow();
    }
    expect(
      sanitizeSvg(
        `<svg ${SVG}><a><animate attributeName="opacity" values="0;1"/>x</a></svg>`,
      ),
    ).toBe(
      `<svg ${SVG}><a><animate attributeName="opacity" values="0;1"/>x</a></svg>`,
    );
  });

  it("keeps raster data images and http links, and rejects malformed markup", () => {
    expect(
      sanitizeSvg(
        `<svg ${SVG}><image href="data:image/png;base64,AAAA"/><a href="https://example.com/?a=1&amp;b=2">x</a></svg>`,
      ),
    ).toBe(
      `<svg ${SVG}><image href="data:image/png;base64,AAAA"/><a href="https://example.com/?a=1&amp;b=2">x</a></svg>`,
    );
    for (const broken of [
      `<svg ${SVG}><scr<script/>ipt>alert(1)</script></svg>`,
      `<svg ${SVG}><scr onx=""ipt>alert(1)</script></svg>`,
      '<!DOCTYPE svg [<!ENTITY x "javascript:">]><svg><a href="&x;alert(1)">x</a></svg>',
      '<svg xmlns="http://example.com/not-svg"/>',
    ]) {
      expect(() => sanitizeSvg(broken), broken).toThrow(
        /not well-formed|not an SVG/,
      );
    }
  });
});

describe("copyAssets / pruneAssets", () => {
  it("copies once, sanitizes SVG, and prunes only its own files after publish", async () => {
    const dir = await project();
    await dir.write("src/a.png", "A");
    const svg = '<svg onload="x()"/>';
    await dir.write("src/b.svg", svg);
    const target = dir.path("out");
    const a = assetRef(dir.path("src/a.png"), "A");
    const b = assetRef(dir.path("src/b.svg"), svg, { stem: "b", svg: true });
    expect(await copyAssets(target, [a, b], { svg: "sanitize" })).toEqual({
      copied: 2,
    });
    expect(await readFile(path.join(target, b.fileName), "utf8")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    expect(await copyAssets(target, [a], { svg: "sanitize" })).toEqual({
      copied: 0,
    });
    expect((await readdir(target)).sort()).toEqual(
      [ASSETS_MANIFEST, a.fileName, b.fileName].sort(),
    );
    expect(await pruneAssets(target, [a])).toEqual({ removed: 1 });
    expect((await readdir(target)).sort()).toEqual([
      ASSETS_MANIFEST,
      a.fileName,
    ]);
  });

  it("fails when a source changed after it was hashed, leaving nothing behind", async () => {
    const dir = await project();
    await dir.write("src/a.png", "A");
    const stale = assetRef(dir.path("src/a.png"), "A");
    await dir.write("src/a.png", "changed");
    await expect(
      copyAssets(dir.path("out"), [stale], { svg: "keep" }),
    ).rejects.toThrow(/changed while the build was running/);
    expect(await readdir(dir.path("out"))).toEqual([ASSETS_MANIFEST]);
  });

  it("stops after the first failure and still records copied files for pruning", async () => {
    const dir = await project();
    const good = [];
    for (let index = 0; index < 4; index += 1) {
      await dir.write(`src/${index}.png`, `file ${index}`);
      good.push(
        assetRef(dir.path(`src/${index}.png`), `file ${index}`, {
          stem: `f${index}`,
        }),
      );
    }
    const missing = assetRef(dir.path("src/missing.png"), "missing", {
      stem: "missing",
    });
    const later = Array.from({ length: 20 }, (_, index) =>
      assetRef(dir.path("src/0.png"), `later ${index}`, {
        stem: `later${index}`,
      }),
    );
    const target = dir.path("out");
    await expect(
      copyAssets(target, [...good, missing, ...later], {
        svg: "keep",
        concurrency: 1,
      }),
    ).rejects.toThrow(/ENOENT/);
    const files = (await readdir(target)).filter(
      (file) => file !== ASSETS_MANIFEST,
    );
    expect(files.sort()).toEqual(good.map((asset) => asset.fileName).sort());
    const manifest: unknown = JSON.parse(
      await readFile(path.join(target, ASSETS_MANIFEST), "utf8"),
    );
    expect(manifest).toMatchObject({ files: files.sort() });
    expect(await pruneAssets(target, [])).toEqual({ removed: 4 });
  });

  it("refuses folders with files it did not create", async () => {
    const dir = await project();
    await dir.write("public/robots.txt", "keep");
    await expect(
      copyAssets(dir.path("public"), [], { svg: "keep" }),
    ).rejects.toThrow(/did not create/);
    expect(await dir.read("public/robots.txt")).toBe("keep");

    await dir.write("backups/backup-20240101.zip", "keep");
    await expect(pruneAssets(dir.path("backups"), [])).rejects.toThrow(
      /did not create/,
    );
    await dir.write("legacy/logo-0123456789abcdef.png", "x");
    await dir.write("legacy/data-0123456789abcdef.json", "x");
    await expect(
      pruneAssets(dir.path("legacy"), [], { extensions: [".png"] }),
    ).rejects.toThrow(/did not create/);
    expect(await dir.read("backups/backup-20240101.zip")).toBe("keep");
  });

  it("adopts an older folder of hashed files and ignores bad manifest entries", async () => {
    const dir = await project();
    await dir.write("legacy/logo-0123456789abcdef.png", "x");
    expect(
      await pruneAssets(dir.path("legacy"), [], { extensions: [".png"] }),
    ).toEqual({ removed: 1 });

    await dir.write("out/keep.txt", "user file");
    await dir.write(
      `out/${ASSETS_MANIFEST}`,
      JSON.stringify({ files: ["..", "", "keep.txt", "../x", "a/b"] }),
    );
    expect(await pruneAssets(dir.path("out"), [])).toEqual({ removed: 0 });
    expect(await dir.read("out/keep.txt")).toBe("user file");
    expect(await pruneAssets(dir.path("out"), [])).toEqual({ removed: 0 });
  });
});

describe("storage", () => {
  function fakeClient(existing: string[]) {
    const keys = new Set(existing);
    const uploads: { key: string; contentType?: string; body: string }[] = [];
    const deletes: string[][] = [];
    let existsCalls = 0;
    const client: AssetStorageClient = {
      upload: async (key, body, options) => {
        uploads.push({
          key,
          contentType: options?.contentType,
          body: await body.text(),
        });
        keys.add(key);
      },
      exists: async (key) => {
        existsCalls += 1;
        return keys.has(key);
      },
      delete: async (batch) => {
        const list = [batch].flat();
        deletes.push(list);
        for (const key of list) keys.delete(key);
      },
      listAll: async function* () {
        for (const key of keys) yield { key };
      },
    };
    return {
      client,
      uploads,
      deletes,
      keys,
      existsCalls: () => existsCalls,
    };
  }

  it("streams missing files with their content type and remembers stored keys", async () => {
    const dir = await project();
    const asset = assetRef(dir.path("src/a.svg"), "<svg/>", { svg: true });
    await dir.write(`out/${asset.fileName}`, "<svg/>");
    const fake = fakeClient(["site/old-0000000000000000.png"]);
    const known = new Set<string>();
    const result = await syncStorage(
      { files: fake.client, prefix: "/site/" },
      dir.path("out"),
      [asset],
      known,
    );
    expect(result).toMatchObject({ uploaded: 1, skipped: 0 });
    expect(fake.uploads).toEqual([
      {
        key: `site/${asset.fileName}`,
        contentType: "image/svg+xml",
        body: "<svg/>",
      },
    ]);
    const again = await syncStorage(
      { files: fake.client, prefix: "site" },
      dir.path("out"),
      [asset],
      known,
    );
    expect(again).toMatchObject({ uploaded: 0, skipped: 1 });
    expect(fake.existsCalls()).toBe(1);
  });

  it("rejects a concurrency that is not a whole number of at least 1", async () => {
    const dir = await project();
    const fake = fakeClient([]);
    for (const concurrency of [Number.NaN, 0, 1.5]) {
      await expect(
        syncStorage(
          { files: fake.client, prefix: "site", concurrency },
          dir.path("out"),
          [assetRef("/x", "A")],
        ),
      ).rejects.toThrow(/concurrency must be a whole number/);
    }
  });

  it("prunes only unused hashed objects directly under the prefix, in batches", async () => {
    const stale = Array.from(
      { length: 1500 },
      (_, index) => `site/old-${index.toString(16).padStart(16, "0")}.png`,
    );
    const foreign = [
      "site/uploads/user-photo-0123456789abcdef.jpg",
      "site/preview/branch-x-0123456789abcdef.png",
      "site/robots.txt",
      "site/backup-20240101.zip",
      "other/old-0123456789abcdef.png",
    ];
    const used = assetRef("/x", "A");
    const fake = fakeClient([...stale, ...foreign, `site/${used.fileName}`]);
    const empty = await pruneStorage(
      { files: fake.client, prefix: "site", prune: true },
      [],
    );
    expect(empty.deleted).toBe(0);
    const off = await pruneStorage({ files: fake.client, prefix: "site" }, [
      used,
    ]);
    expect(off.deleted).toBe(0);
    const pruned = await pruneStorage(
      { files: fake.client, prefix: "site", prune: true },
      [used],
    );
    expect(pruned.deleted).toBe(1500);
    expect(fake.deletes.map((batch) => batch.length)).toEqual([1000, 500]);
    expect([...fake.keys].sort()).toEqual(
      [...foreign, `site/${used.fileName}`].sort(),
    );
  });
});

describe("runPool via copyAssets", () => {
  it("rejects a bad concurrency", async () => {
    const dir = await project();
    await dir.write("a.png", "A");
    await expect(
      copyAssets(dir.path("out"), [assetRef(dir.path("a.png"), "A")], {
        svg: "keep",
        concurrency: Number.NaN,
      }),
    ).rejects.toThrow(/concurrency/);
  });
});
