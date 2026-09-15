import type { ComponentType, ReactNode } from "react";

export type MDXElementProps = {
  children?: ReactNode;
  components?: MDXComponents;
};

export type MDXComponents = Record<string, ComponentType<MDXElementProps>>;
