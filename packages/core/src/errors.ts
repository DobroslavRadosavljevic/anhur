import { PlatformError } from "effect/PlatformError";
import { Predicate } from "effect";
import {
  ConfigInvalidError,
  ConfigNotFoundError,
  LocalizationConfigError,
  SingletonAmbiguousError,
  SingletonMissingError,
} from "./errors-config";
import {
  LoaderFailedError,
  LoaderNotFoundError,
  ReferenceFailedError,
  TransformFailedError,
  ValidationFailedError,
} from "./errors-content";
export {
  ConfigInvalidError,
  ConfigNotFoundError,
  LocalizationConfigError,
  SingletonAmbiguousError,
  SingletonMissingError,
};
export {
  LoaderFailedError,
  LoaderNotFoundError,
  ReferenceFailedError,
  TransformFailedError,
  ValidationFailedError,
};

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

function isPathReason(
  reason: PlatformError["reason"],
): reason is PlatformError["reason"] & { path: string } {
  return "path" in reason && Predicate.isString(reason.path);
}

function isDescriptionReason(
  reason: PlatformError["reason"],
): reason is PlatformError["reason"] & { description: string } {
  return "description" in reason && Predicate.isString(reason.description);
}

export function formatAnhurError(cause: AnhurError | Error): string {
  if (cause instanceof ValidationFailedError) {
    const detail = cause.issues
      .map((issue) => {
        const path = issue.path?.map(String).join(".") ?? "";
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
    return `Validation failed for ${cause.filePath}:\n${detail}`;
  }

  if (cause instanceof TransformFailedError) {
    return `Transform failed for ${cause.filePath}: ${cause.detail}`;
  }

  if (cause instanceof ReferenceFailedError) {
    const path = cause.fieldPath.map(String).join(".") || "(root)";
    return `Reference failed for ${cause.filePath} at ${path}: ${cause.detail}`;
  }

  if (cause instanceof LoaderNotFoundError) {
    return `No loader matched file: ${cause.filePath}`;
  }

  if (cause instanceof LoaderFailedError) {
    return `Loader failed for ${cause.filePath}: ${cause.detail}`;
  }

  if (cause instanceof ConfigNotFoundError) {
    return `Anhur config not found: ${cause.path}`;
  }

  if (cause instanceof ConfigInvalidError) {
    return `Invalid config at ${cause.path}: ${cause.detail}`;
  }

  if (cause instanceof LocalizationConfigError) {
    return cause.detail;
  }

  if (cause instanceof SingletonMissingError) {
    return `Singleton "${cause.name}" file not found: ${cause.path}`;
  }

  if (cause instanceof SingletonAmbiguousError) {
    return `Singleton "${cause.name}" locale "${cause.locale}" matched multiple files: ${cause.files.join(", ")}`;
  }

  if (cause instanceof PlatformError) {
    const reason = cause.reason;
    const path = isPathReason(reason) ? reason.path : undefined;
    const description = isDescriptionReason(reason)
      ? reason.description
      : reason._tag;
    return path
      ? `Platform ${reason._tag} for ${path}: ${description}`
      : `Platform ${reason._tag}: ${description}`;
  }

  return cause.message;
}
