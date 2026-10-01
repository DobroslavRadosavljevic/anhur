import { runSync } from "@mdx-js/mdx";
import type { MDXContent } from "mdx/types";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

const CACHE_LIMIT = 256;
const cache = new Map<string, MDXContent>();

function isMdxModule(value: unknown): value is { default: MDXContent } {
  return (
    value !== null &&
    typeof value === "object" &&
    "default" in value &&
    typeof value.default === "function"
  );
}

/**
 * Turn compiled MDX (a function body from `m.body()` / `m.mdx()`) into a
 * React component. Components are cached by code, so evaluation runs once
 * per distinct document. Evaluation uses `new Function`: pages need a CSP
 * that allows it (`'unsafe-eval'`), and runtimes that forbid code
 * generation (Cloudflare Workers, Vercel Edge) cannot render MDX at all.
 */
export function getMdxComponent(code: string): MDXContent {
  const cached = cache.get(code);
  if (cached) {
    cache.delete(code);
    cache.set(code, cached);
    return cached;
  }
  const module: unknown = runSync(code, {
    Fragment,
    jsx,
    jsxs,
    baseUrl: import.meta.url,
  });
  if (!isMdxModule(module)) {
    throw new Error("@anhur/mdx: compiled MDX has no default component.");
  }
  cache.set(code, module.default);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return module.default;
}
