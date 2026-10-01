const REMOTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** `https://cdn/x/`, `//cdn/x/` (any absolute URL with an authority). */
export function isRemoteUrl(value: string): boolean {
  return REMOTE.test(value.trim());
}

/**
 * Percent-encode characters that are not valid in a URL path (spaces,
 * non-ASCII, `?`, `#`, …). Existing `%XX` escapes are kept.
 */
function encodeUrlPath(value: string): string {
  return value.replace(
    /%(?![0-9a-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]+/gi,
    (match) => encodeURIComponent(match),
  );
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function withLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * Host app public base (Vite `base`). `./` and `""` are HTML-relative, which
 * generated strings cannot honour, so they count as `/`.
 */
function normalizeAppBase(appBase: string | undefined): string {
  const trimmed = appBase?.trim();
  if (!trimmed || trimmed === "./" || trimmed === ".") return "/";
  return withTrailingSlash(encodeUrlPath(trimmed));
}

function joinPaths(appPath: string, assetsPath: string): string {
  const app = withTrailingSlash(withLeadingSlash(appPath));
  const assets = withTrailingSlash(withLeadingSlash(assetsPath));
  if (assets === app || assets.startsWith(app)) return assets;
  return `${app.replace(/\/+$/, "")}${assets}`;
}

/**
 * Public URL prefix for generated asset URLs. A remote `assetsBase` is used
 * as is; otherwise the app base is prepended unless already present.
 */
export function joinPublicAssetBase(
  appBase: string | undefined,
  assetsBase: string,
): string {
  const assets = withTrailingSlash(encodeUrlPath(assetsBase.trim()));
  if (isRemoteUrl(assets)) return assets;
  const app = normalizeAppBase(appBase);
  if (app === "/") return withLeadingSlash(assets);
  if (isRemoteUrl(app)) {
    const absolute = app.startsWith("//") ? `https:${app}` : app;
    const url = new URL(absolute);
    const joined = joinPaths(url.pathname, assets);
    return app.startsWith("//")
      ? `//${url.host}${joined}`
      : `${url.origin}${joined}`;
  }
  return joinPaths(app, assets);
}

export type AssetBases = {
  /** Prefix written into generated URLs. */
  readonly publicBase: string;
  /**
   * URL-encoded path prefix (without the app base) used to copy files into
   * the app output and to serve them in dev: `/anhur-assets/`, or `/` when
   * the assets base is the app base itself (files then sit at the root of
   * the app output). `undefined` for remote bases.
   */
  readonly localBase: string | undefined;
};

/**
 * Public + local prefixes for a configured assets base and app base. Bases
 * are percent-encoded (`/my assets/` → `/my%20assets/`).
 */
export function resolveAssetBases(
  assetsBase: string,
  appBase?: string,
): AssetBases {
  const configured = withTrailingSlash(encodeUrlPath(assetsBase.trim()));
  if (isRemoteUrl(configured)) {
    return { publicBase: configured, localBase: undefined };
  }
  const local = withLeadingSlash(configured);
  const publicBase = joinPublicAssetBase(appBase, local);
  const app = normalizeAppBase(appBase);
  let localBase = local;
  if (!isRemoteUrl(app) && app !== "/" && local.startsWith(app)) {
    localBase = withLeadingSlash(withTrailingSlash(local.slice(app.length)));
  }
  return { publicBase, localBase };
}
