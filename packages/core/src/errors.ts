import { Data } from "effect";
import { PlatformError } from "effect/PlatformError";

export type ValidationIssue = {
  readonly message: string;
  readonly path?: readonly (string | number | symbol)[];
};

export class ConfigNotFoundError extends Data.TaggedError(
  "ConfigNotFoundError",
)<{
  readonly path: string;
}> {}

export class ConfigInvalidError extends Data.TaggedError("ConfigInvalidError")<{
  readonly path: string;
  readonly detail: string;
}> {}

export class LocalizationConfigError extends Data.TaggedError(
  "LocalizationConfigError",
)<{
  readonly detail: string;
}> {}

export class SingletonMissingError extends Data.TaggedError(
  "SingletonMissingError",
)<{
  readonly name: string;
  readonly path: string;
}> {}

export class SingletonAmbiguousError extends Data.TaggedError(
  "SingletonAmbiguousError",
)<{
  readonly name: string;
  readonly locale: string;
  readonly files: readonly string[];
}> {}

export class ValidationFailedError extends Data.TaggedError(
  "ValidationFailedError",
)<{
  readonly filePath: string;
  readonly issues: readonly ValidationIssue[];
}> {}

export class TransformFailedError extends Data.TaggedError(
  "TransformFailedError",
)<{
  readonly filePath: string;
  readonly detail: string;
}> {}

export class ReferenceFailedError extends Data.TaggedError(
  "ReferenceFailedError",
)<{
  readonly filePath: string;
  readonly fieldPath: readonly (string | number)[];
  readonly detail: string;
}> {}

export class LoaderNotFoundError extends Data.TaggedError(
  "LoaderNotFoundError",
)<{
  readonly filePath: string;
}> {}

export class LoaderFailedError extends Data.TaggedError("LoaderFailedError")<{
  readonly filePath: string;
  readonly detail: string;
}> {}

export type AnhurError =
  | ConfigNotFoundError
  | ConfigInvalidError
  | LocalizationConfigError
  | SingletonMissingError
  | SingletonAmbiguousError
  | ValidationFailedError
  | TransformFailedError
  | ReferenceFailedError
  | LoaderNotFoundError
  | LoaderFailedError
  | PlatformError;

export function formatAnhurError(error: unknown): string {
  if (error instanceof ValidationFailedError) {
    const detail = error.issues
      .map((issue) => {
        const path = issue.path?.map(String).join(".") ?? "";
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
    return `Validation failed for ${error.filePath}:\n${detail}`;
  }

  if (error instanceof TransformFailedError) {
    return `Transform failed for ${error.filePath}: ${error.detail}`;
  }

  if (error instanceof ReferenceFailedError) {
    const path = error.fieldPath.map(String).join(".") || "(root)";
    return `Reference failed for ${error.filePath} at ${path}: ${error.detail}`;
  }

  if (error instanceof LoaderNotFoundError) {
    return `No loader matched file: ${error.filePath}`;
  }

  if (error instanceof LoaderFailedError) {
    return `Loader failed for ${error.filePath}: ${error.detail}`;
  }

  if (error instanceof ConfigNotFoundError) {
    return `Anhur config not found: ${error.path}`;
  }

  if (error instanceof ConfigInvalidError) {
    return `Invalid config at ${error.path}: ${error.detail}`;
  }

  if (error instanceof LocalizationConfigError) {
    return error.detail;
  }

  if (error instanceof SingletonMissingError) {
    return `Singleton "${error.name}" file not found: ${error.path}`;
  }

  if (error instanceof SingletonAmbiguousError) {
    return `Singleton "${error.name}" locale "${error.locale}" matched multiple files: ${error.files.join(", ")}`;
  }

  if (error instanceof PlatformError) {
    const reason = error.reason;
    const path =
      "path" in reason && typeof reason.path === "string"
        ? reason.path
        : undefined;
    const description =
      "description" in reason && typeof reason.description === "string"
        ? reason.description
        : reason._tag;
    return path
      ? `Platform ${reason._tag} for ${path}: ${description}`
      : `Platform ${reason._tag}: ${description}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
