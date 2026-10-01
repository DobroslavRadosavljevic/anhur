import { Predicate, Schema } from "effect";
import {
  AnhurBuildError,
  formatDiagnostics,
  type Diagnostic,
} from "../diagnostics";

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    Predicate.isObject(value) &&
    "code" in value &&
    Predicate.isString(value.code) &&
    "severity" in value &&
    (value.severity === "error" || value.severity === "warning") &&
    "message" in value &&
    Predicate.isString(value.message)
  );
}

const DiagnosticSchema = Schema.declare(isDiagnostic);

/** Typed failure of every engine stage: one or more error diagnostics. */
export class BuildFailedError extends Schema.TaggedError<BuildFailedError>()(
  "BuildFailedError",
  {
    diagnostics: Schema.Array(DiagnosticSchema),
  },
) {
  override get message(): string {
    return formatDiagnostics(this.diagnostics);
  }
}

/** Fail with these diagnostics (they must contain at least one error). */
export function buildFailed(
  diagnostics: readonly Diagnostic[],
): BuildFailedError {
  return new BuildFailedError({ diagnostics: [...diagnostics] });
}

/** Promise-API error for a failed build. */
export function toAnhurBuildError(
  error: BuildFailedError,
  relativeTo: string | undefined,
): AnhurBuildError {
  return new AnhurBuildError(error.diagnostics, { relativeTo });
}
