import { utimes } from "node:fs/promises";
import type { TestProject } from "./temp-project";

/** Counters the test configs write to (a config runs in the test process). */
type Counts = { [name: string]: number | undefined };
// SAFETY: a global the test configs and the tests agree on.
const shared = globalThis as { anhurCounts?: Counts };

export function count(name: string): number {
  return shared.anhurCounts?.[name] ?? 0;
}

export function resetCounts(): void {
  shared.anhurCounts = {};
}

/** Source text for a test config: `bump(name)` adds one to a counter. */
export const COUNTING = `
const counts = ((globalThis as { anhurCounts?: Record<string, number> }).anhurCounts ??= {});
const bump = (name: string) => {
  const store = ((globalThis as { anhurCounts?: Record<string, number> }).anhurCounts ??= counts);
  store[name] = (store[name] ?? 0) + 1;
};
`;

/**
 * Give files a time one minute in the past. Call it BEFORE the first build:
 * the engine trusts the size and times of a file only when the file was
 * last changed some seconds before it was read. A file changed after it
 * was read (also by this function) is compared by content instead.
 */
export async function makeOld(
  dir: TestProject,
  ...files: string[]
): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  for (const file of files) await utimes(dir.path(file), past, past);
}
