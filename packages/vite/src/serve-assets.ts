import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { contentTypeForPath } from "@anhur/core/plugin";

/** Where copied assets live and under which URL prefixes they are served. */
export type AssetRoute = {
  /** Absolute folder with the copied files. */
  readonly dir: string;
  /** URL path prefixes (`/anhur-assets/`, `/app/anhur-assets/`). */
  readonly prefixes: readonly string[];
};

/** Path under `dir` for a request URL, or `undefined` (wrong prefix, traversal, dotfile). */
export function resolveAssetRequest(
  route: AssetRoute,
  url: string,
): string | undefined {
  const pathname = (url.split("?")[0] ?? "").split("#")[0] ?? "";
  for (const raw of route.prefixes) {
    const prefix = raw.endsWith("/") ? raw : `${raw}/`;
    if (!pathname.startsWith(prefix)) continue;
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return undefined;
    }
    if (
      relative.length === 0 ||
      relative.split(/[\\/]/).some((part) => part.startsWith("."))
    ) {
      return undefined;
    }
    const file = path.resolve(route.dir, relative);
    const root = path.resolve(route.dir);
    if (!file.startsWith(root + path.sep)) return undefined;
    return file;
  }
  return undefined;
}

type Next = (cause?: unknown) => void;

/**
 * Headers for SVGs opened directly: no scripts, plugins or external loads
 * even when an SVG was copied with `svg: "keep"`.
 */
export const SVG_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; sandbox";

type RangeResult =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const FULL: RangeResult = { kind: "full" };

/**
 * `Range` header (RFC 9110 §14). Other units, several ranges and invalid
 * syntax are ignored (the whole file is sent); a valid single range that
 * starts past the end is unsatisfiable.
 */
export function parseRange(header: string, size: number): RangeResult {
  const unit = /^\s*bytes\s*=(.*)$/i.exec(header);
  if (!unit) return FULL;
  const specs = unit[1]!
    .split(",")
    .map((spec) => spec.trim())
    .filter((spec) => spec !== "");
  if (specs.length !== 1) return FULL;
  const match = /^(\d*)\s*-\s*(\d*)$/.exec(specs[0]!);
  if (!match) return FULL;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return FULL;
  if (from === "") {
    const length = Number(to);
    if (length === 0 || size === 0) return { kind: "unsatisfiable" };
    return {
      kind: "partial",
      start: Math.max(0, size - length),
      end: size - 1,
    };
  }
  const start = Number(from);
  if (to !== "" && Number(to) < start) return FULL;
  if (start >= size) return { kind: "unsatisfiable" };
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return { kind: "partial", start, end };
}

function opaqueTag(tag: string): string {
  return tag.trim().replace(/^W\//, "");
}

/** `If-None-Match` matches `etag` (weak comparison; `*` matches any file). */
export function matchesIfNoneMatch(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const wanted = opaqueTag(etag);
  return header.split(",").some((tag) => opaqueTag(tag) === wanted);
}

/**
 * Dev middleware for copied assets: GET / HEAD, single `Range` requests
 * (video seeking), `ETag` / `If-None-Match`, correct content types,
 * `X-Content-Type-Options: nosniff`, and a locked-down CSP for SVGs.
 * `getRoute` is read per request, so the route can change after rebuilds.
 */
export function serveAssets(getRoute: () => AssetRoute | undefined) {
  return (
    request: IncomingMessage,
    response: ServerResponse,
    next: Next,
  ): void => {
    const route = getRoute();
    if (!route || (request.method !== "GET" && request.method !== "HEAD")) {
      next();
      return;
    }
    const file = resolveAssetRequest(route, request.url ?? "");
    if (!file) {
      next();
      return;
    }
    stat(file).then(
      (info) => {
        if (!info.isFile()) {
          next();
          return;
        }
        const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        const contentType = contentTypeForPath(file);
        response.setHeader("Content-Type", contentType);
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (contentType.startsWith("image/svg+xml")) {
          response.setHeader(
            "Content-Security-Policy",
            SVG_CONTENT_SECURITY_POLICY,
          );
        }
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("ETag", etag);
        response.setHeader("Cache-Control", "no-cache");
        const ifNoneMatch = request.headers["if-none-match"];
        if (
          ifNoneMatch !== undefined &&
          matchesIfNoneMatch(ifNoneMatch, etag)
        ) {
          response.statusCode = 304;
          response.end();
          return;
        }
        // A weak ETag never satisfies If-Range, so any If-Range sends the whole file.
        const range =
          request.headers.range === undefined ||
          request.headers["if-range"] !== undefined
            ? FULL
            : parseRange(request.headers.range, info.size);
        if (range.kind === "unsatisfiable") {
          response.statusCode = 416;
          response.setHeader("Content-Range", `bytes */${info.size}`);
          response.end();
          return;
        }
        const start = range.kind === "partial" ? range.start : 0;
        const end = range.kind === "partial" ? range.end : info.size - 1;
        response.statusCode = range.kind === "partial" ? 206 : 200;
        if (range.kind === "partial") {
          response.setHeader(
            "Content-Range",
            `bytes ${start}-${end}/${info.size}`,
          );
        }
        response.setHeader(
          "Content-Length",
          String(info.size === 0 ? 0 : end - start + 1),
        );
        if (request.method === "HEAD" || info.size === 0) {
          response.end();
          return;
        }
        const stream = createReadStream(file, { start, end });
        stream.on("error", (error) => {
          if (response.headersSent) response.destroy(error);
          else next(error);
        });
        stream.pipe(response);
      },
      () => {
        next();
      },
    );
  };
}
