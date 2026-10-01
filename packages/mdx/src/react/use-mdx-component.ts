import type { MDXContent } from "mdx/types";
import { useMemo } from "react";
import { getMdxComponent } from "./get-mdx-component";

/** Memoized component for compiled MDX code. */
export function useMdxComponent(code: string): MDXContent {
  return useMemo(() => getMdxComponent(code), [code]);
}
