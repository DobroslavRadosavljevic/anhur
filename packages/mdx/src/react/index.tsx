import { runSync } from "@mdx-js/mdx";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useMemo, type ComponentType, type ReactNode } from "react";
import type { MDXComponents, MDXElementProps } from "./mdx-components";

export type { MDXComponents } from "./mdx-components";

export type MDXContentProps = {
  /** Compiled function-body string from `compileMdx`. */
  code: string;
  components?: MDXComponents;
  children?: ReactNode;
};

function isMdxModule<T>(
  value: T,
): value is T & { default: ComponentType<MDXElementProps> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "function"
  );
}

/**
 * Turn compiled MDX code into a React component (sync).
 */
export function getMDXComponent(code: string): ComponentType<MDXElementProps> {
  const module = runSync(code, { Fragment, jsx, jsxs });
  if (!isMdxModule(module)) {
    throw new Error(
      "@anhur/mdx: compiled MDX did not export a default component.",
    );
  }
  return module.default;
}

/**
 * Memoized React component for a compiled MDX function-body string.
 */
export function useMDXComponent(code: string): ComponentType<MDXElementProps> {
  return useMemo(() => getMDXComponent(code), [code]);
}

/**
 * Render compiled MDX. Pass `components` to override HTML/MDX elements.
 */
export function MDXContent({ code, components, ...props }: MDXContentProps) {
  const Component = useMDXComponent(code);
  return <Component components={components} {...props} />;
}
