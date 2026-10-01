/**
 * `@anhur/core/build` — the build engine for hosts (CLI, Vite, scripts).
 */
export {
  build,
  check,
  watch,
  createAnhur,
  type AnhurSession,
  type WatchController,
  type WatchHandlers,
} from "./runtime";
export type {
  BuildAssets,
  BuildOptions,
  BuildResult,
  SourceSummary,
  WatchTargets,
} from "../engine/result";
export { isRelevantChange, type WatchOptions } from "../engine/watcher.service";
export { CONFIG_FILE_NAMES } from "../engine/config-loader.service";
export { MANIFEST_FILE } from "../engine/output.service";
export {
  AnhurBuildError,
  isAnhurBuildError,
  formatDiagnostic,
  formatDiagnostics,
  type Diagnostic,
} from "../diagnostics";
