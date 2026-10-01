import type { MDXComponents } from "mdx/types";
import { useMdxComponent } from "./use-mdx-component";

export type MdxContentProps = {
  /** Compiled MDX from `m.body()` / `m.mdx()`. */
  readonly code: string;
  /** Override HTML elements or provide components used in the MDX. */
  readonly components?: MDXComponents;
};

/** Render compiled MDX. */
export function MdxContent({ code, components }: MdxContentProps) {
  const Component = useMdxComponent(code);
  return <Component components={components} />;
}
