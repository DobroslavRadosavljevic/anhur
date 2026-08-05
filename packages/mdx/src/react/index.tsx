import { runSync } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { useMemo, type ComponentType, type ReactNode } from "react";

export type MDXComponents = Record<
  string,
  ComponentType<Record<string, unknown>>
>;

export type MDXContentProps = {
  /** Compiled function-body string from `compileMdx`. */
  code: string;
  components?: MDXComponents;
  children?: ReactNode;
  [key: string]: unknown;
};

/**
 * Turn compiled MDX code into a React component (sync).
 */
export function getMDXComponent(
  code: string,
): ComponentType<Record<string, unknown>> {
  const { default: Component } = runSync(code, {
    ...runtime,
  }) as { default: ComponentType<Record<string, unknown>> };
  return Component;
}

/**
 * Memoized React component for a compiled MDX function-body string.
 */
export function useMDXComponent(
  code: string,
): ComponentType<Record<string, unknown>> {
  return useMemo(() => getMDXComponent(code), [code]);
}

/**
 * Render compiled MDX. Pass `components` to override HTML/MDX elements.
 */
export function MDXContent({ code, components, ...props }: MDXContentProps) {
  const Component = useMDXComponent(code);
  return <Component components={components} {...props} />;
}
