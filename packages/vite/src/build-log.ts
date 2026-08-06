import path from "node:path";
import type { BuildResult } from "@anhur/core";

export type BuildLogKind = "built" | "rebuilt";

const MAX_IDS_PER_SOURCE = 40;

function documentLabel(meta: { id: string; locale?: string }): string {
  return meta.locale ? `${meta.locale}/${meta.id}` : meta.id;
}

/**
 * Human-readable Anhur build lines for Vite (and similar) loggers.
 */
export function formatAnhurBuildLog(
  result: BuildResult,
  kind: BuildLogKind,
  options: { rootDir?: string } = {},
): string[] {
  const total = result.built.reduce((n, item) => n + item.documents.length, 0);
  const output = options.rootDir
    ? path.relative(options.rootDir, result.outputDir) || result.outputDir
    : result.outputDir;

  const lines = [`[anhur] ${kind} ${total} document(s) → ${output}`];

  for (const item of result.built) {
    const ids = item.documents.map((doc) => documentLabel(doc._meta));
    const shown = ids.slice(0, MAX_IDS_PER_SOURCE);
    const rest = ids.length - shown.length;
    const list =
      ids.length === 0
        ? "(none)"
        : rest > 0
          ? `${shown.join(", ")} … +${rest} more`
          : shown.join(", ");

    lines.push(`[anhur]   ${item.source.name} (${ids.length}): ${list}`);
  }

  return lines;
}
