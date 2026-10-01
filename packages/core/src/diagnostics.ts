import { formatFieldPath, type FieldPath } from "./document";

/**
 * Stable machine-readable diagnostic codes. Each pipeline stage reports with
 * its own code so hosts can group or filter problems.
 */
export type DiagnosticCode =
  | "config-not-found"
  | "config-load-failed"
  | "config-invalid"
  | "naming-invalid"
  | "naming-collision"
  | "path-unsafe"
  | "source-missing"
  | "singleton-missing"
  | "singleton-ambiguous"
  | "duplicate-id"
  | "read-failed"
  | "loader-missing"
  | "loader-failed"
  | "field-failed"
  | "validation-failed"
  | "transform-failed"
  | "reference-failed"
  | "unique-conflict"
  | "derive-failed"
  | "serialize-failed"
  | "hook-failed"
  | "plugin-failed"
  | "asset-failed"
  | "output-unsafe"
  | "output-locked"
  | "publish-failed"
  | "internal";

export type DiagnosticSeverity = "error" | "warning";

/** One problem found while loading config or building content. */
export type Diagnostic = {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Source file (absolute path) the problem belongs to. */
  readonly file?: string;
  /** Field inside the document (`["author"]`, `["tags", 1]`). */
  readonly fieldPath?: FieldPath;
  /** Content source (collection / singleton / view) name. */
  readonly source?: string;
  /** What to change to fix it. */
  readonly hint?: string;
  /** Original thrown value, kept for stack traces. */
  readonly cause?: unknown;
};

/** Build a diagnostic with `severity: "error"`. */
export function errorDiagnostic(
  code: DiagnosticCode,
  message: string,
  extra: Omit<Diagnostic, "code" | "severity" | "message"> = {},
): Diagnostic {
  return { code, severity: "error", message, ...extra };
}

/** Build a diagnostic with `severity: "warning"`. */
export function warningDiagnostic(
  code: DiagnosticCode,
  message: string,
  extra: Omit<Diagnostic, "code" | "severity" | "message"> = {},
): Diagnostic {
  return { code, severity: "warning", message, ...extra };
}

/** Message of a thrown value (falls back to `String(cause)`). */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export type FormatDiagnosticOptions = {
  /** Make file paths relative to this directory. */
  readonly relativeTo?: string;
};

function displayFile(file: string, relativeTo: string | undefined): string {
  if (!relativeTo) return file;
  const root = relativeTo.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = file.replace(/\\/g, "/");
  if (normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return file;
}

/** One diagnostic as text: `file › field: message [code]` plus an optional hint line. */
export function formatDiagnostic(
  diagnostic: Diagnostic,
  options: FormatDiagnosticOptions = {},
): string {
  const where: string[] = [];
  if (diagnostic.file) {
    where.push(displayFile(diagnostic.file, options.relativeTo));
  } else if (diagnostic.source) {
    where.push(diagnostic.source);
  }
  const field = formatFieldPath(diagnostic.fieldPath);
  if (field) where.push(field);
  const prefix = where.length > 0 ? `${where.join(" › ")}: ` : "";
  const label = diagnostic.severity === "warning" ? "warning " : "";
  let text = `${label}${prefix}${diagnostic.message} [${diagnostic.code}]`;
  if (diagnostic.hint) text += `\n  hint: ${diagnostic.hint}`;
  return text;
}

/** Many diagnostics as text, errors first, one block per diagnostic. */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: FormatDiagnosticOptions = {},
): string {
  const ordered = [...diagnostics].sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === "error" ? -1 : 1;
  });
  return ordered
    .map((diagnostic) => formatDiagnostic(diagnostic, options))
    .join("\n");
}

/** True when any diagnostic is an error. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/**
 * Thrown by the Promise API (`build`, `createAnhur().build()`, …) when config
 * loading or a build fails. `diagnostics` lists every problem found; the
 * message is the formatted list.
 */
export class AnhurBuildError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(
    diagnostics: readonly Diagnostic[],
    options: FormatDiagnosticOptions = {},
  ) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    const count = errors.length;
    const head =
      count === 1
        ? "Anhur build failed with 1 error:"
        : `Anhur build failed with ${count} errors:`;
    super(`${head}\n${formatDiagnostics(diagnostics, options)}`);
    this.name = "AnhurBuildError";
    this.diagnostics = diagnostics;
  }
}

/** Duck-typed check that also works across duplicated module instances. */
export function isAnhurBuildError(cause: unknown): cause is AnhurBuildError {
  return (
    cause instanceof Error &&
    cause.name === "AnhurBuildError" &&
    "diagnostics" in cause &&
    Array.isArray(cause.diagnostics)
  );
}
