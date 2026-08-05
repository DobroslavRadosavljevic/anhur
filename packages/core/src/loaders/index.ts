import { jsonLoader } from "./json";
import { matterLoader } from "./matter";
import type { Loader } from "./types";
import { yamlLoader } from "./yaml";

export type { LoadedFile, Loader } from "./types";
export { defineLoader } from "./types";
export { matterLoader } from "./matter";
export { yamlLoader } from "./yaml";
export { jsonLoader } from "./json";

export const builtinLoaders: readonly Loader[] = [
  matterLoader(),
  yamlLoader(),
  jsonLoader(),
];

/**
 * User loaders first, then built-ins. First `test` match wins.
 */
export function resolveLoaders(userLoaders?: readonly Loader[]): Loader[] {
  return [...(userLoaders ?? []), ...builtinLoaders];
}

export function findLoader(
  filePath: string,
  loaders: readonly Loader[],
): Loader | undefined {
  return loaders.find((loader) => loader.test.test(filePath));
}
