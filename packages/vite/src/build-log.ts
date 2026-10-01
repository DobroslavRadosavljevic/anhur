import path from "node:path";
import { formatDiagnostics, type BuildResult } from "@anhur/core/build";

/** Log lines for a finished build. */
export function formatBuildLog(
  result: BuildResult,
  kind: "built" | "rebuilt",
  durationMs: number,
): string[] {
  const output =
    path.relative(result.projectDir, result.outputDir) || result.outputDir;
  const sources = result.sources
    .map((source) => `${source.name} ${source.documents.length}`)
    .join(", ");
  const changed =
    result.written.length === 0 && result.removed.length === 0
      ? "no changes"
      : `${result.written.length} written, ${result.removed.length} removed`;
  const lines = [
    `[anhur] ${kind} ${result.documentCount} document(s) in ${Math.round(durationMs)}ms → ${output} (${changed}; ${sources})`,
    ...result.messages.map((message) => `[anhur]   ${message}`),
  ];
  if (result.warnings.length > 0) {
    lines.push(
      formatDiagnostics(result.warnings, { relativeTo: result.projectDir }),
    );
  }
  return lines;
}
