import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Predicate } from "effect";

type NodeErrno = {
  readonly code: string;
};

function isNodeErrno(cause: unknown): cause is NodeErrno {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    Predicate.isString(cause.code)
  );
}

/**
 * Atomically replace `liveDir` with the contents of `stagingDir`.
 *
 * Uses a sibling `*.prev` backup so a failed rename cannot leave the live
 * directory missing. Callers should only invoke this after a fully successful
 * build into `stagingDir`.
 */
export async function publishStagingDirectory(
  stagingDir: string,
  liveDir: string,
): Promise<void> {
  const live = path.resolve(liveDir);
  const staging = path.resolve(stagingDir);
  if (live === staging) {
    throw new Error(
      "@anhur/core: publishStagingDirectory requires distinct staging and live paths.",
    );
  }

  const parent = path.dirname(live);
  await mkdir(parent, { recursive: true });

  const prev = `${live}.prev`;
  await rm(prev, { recursive: true, force: true });

  try {
    await stat(live);
    await rename(live, prev);
  } catch (error) {
    if (!isNodeErrno(error) || error.code !== "ENOENT") throw error;
  }

  try {
    await rename(staging, live);
  } catch (error) {
    // Best-effort rollback if the staging → live swap fails.
    try {
      await stat(prev);
      await rename(prev, live);
    } catch {
      // ignore rollback failures
    }
    throw error;
  }

  await rm(prev, { recursive: true, force: true });
}

/** Staging sibling used while a build is in progress. */
export function stagingDirectoryFor(liveDir: string): string {
  return `${path.resolve(liveDir)}.building`;
}
