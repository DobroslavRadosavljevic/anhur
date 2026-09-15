const REMOTE_BASE = /^(?:https?:)?\/\//i;

export function isRemoteAssetBase(base: string): boolean {
  return REMOTE_BASE.test(base.trim());
}

export function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/**
 * Vite `./` / `""` are HTML-relative. Generated content strings are not
 * rewritten by Vite, so treat those as origin-absolute `/`.
 */
export function normalizeAppPublicBase(appBase: string | undefined): string {
  if (!appBase || appBase === "./" || appBase === ".") return "/";
  return ensureTrailingSlash(appBase);
}

function normalizeLocalAssetBase(base: string): string {
  const trimmed = ensureTrailingSlash(base);
  if (isRemoteAssetBase(trimmed)) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function joinPathBases(appPath: string, assetsPath: string): string {
  const app = ensureTrailingSlash(
    appPath.startsWith("/") ? appPath : `/${appPath}`,
  );
  const assets = ensureTrailingSlash(
    assetsPath.startsWith("/") ? assetsPath : `/${assetsPath}`,
  );
  if (assets === app || assets.startsWith(app)) return assets;
  return ensureTrailingSlash(
    `${app.replace(/\/+$/, "")}/${assets.replace(/^\/+/, "")}`,
  );
}

/**
 * Public URL prefix for generated asset `src` values.
 * Remote `assets.base` is left unchanged. Otherwise Vite `base` is joined,
 * unless `assets.base` already starts with that pathname (no double prefix).
 */
export function joinPublicAssetBase(
  appBase: string | undefined,
  assetsBase: string,
): string {
  const assets = normalizeLocalAssetBase(assetsBase);
  if (isRemoteAssetBase(assets)) return assets;

  const app = normalizeAppPublicBase(appBase);
  if (app === "/") return assets;

  if (isRemoteAssetBase(app)) {
    const origin = app.startsWith("//") ? `https:${app}` : app;
    const url = new URL(origin);
    const joinedPath = joinPathBases(url.pathname, assets);
    if (app.startsWith("//")) {
      return `//${url.host}${joinedPath}`;
    }
    return `${url.origin}${joinedPath}`;
  }

  return joinPathBases(app, assets);
}

export function resolvePublicAndLocalAssetBases(
  configuredAssetsBase: string,
  appBase?: string,
): { publicBase: string; localBase: string | undefined } {
  const configured = normalizeLocalAssetBase(configuredAssetsBase);
  if (isRemoteAssetBase(configured)) {
    return { publicBase: configured, localBase: undefined };
  }

  const publicBase = joinPublicAssetBase(appBase, configured);
  const app = normalizeAppPublicBase(appBase);

  let localBase = configured;
  if (!isRemoteAssetBase(app) && app !== "/") {
    if (localBase === app || localBase.startsWith(app)) {
      const stripped = localBase.slice(app.length);
      localBase = ensureTrailingSlash(`/${stripped.replace(/^\/+/, "")}`);
    }
  }

  return { publicBase, localBase };
}

/** Path under Vite `outDir` (`/anhur-assets/` → `anhur-assets`). */
export function assetsOutDirSegment(localBase: string): string {
  return localBase.replace(/^\//, "").replace(/\/$/, "");
}

/**
 * Strip a matching public or local asset prefix from `req.url`.
 * Tries prefixes in order so Vite-base and stripped-base requests both match.
 */
export function relativeAssetRequestPath(
  requestUrl: string,
  prefixes: readonly (string | undefined)[],
): string | null {
  const pathOnly = (requestUrl.split("?")[0] ?? "").split("#")[0] ?? "";
  for (const raw of prefixes) {
    if (!raw || isRemoteAssetBase(raw)) continue;
    const prefix = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!prefix.startsWith("/")) continue;
    if (pathOnly === prefix) return "/";
    if (pathOnly.startsWith(`${prefix}/`)) {
      return pathOnly.slice(prefix.length);
    }
  }
  return null;
}
