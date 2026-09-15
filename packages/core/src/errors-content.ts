import { Schema } from "effect";

export type ValidationIssue = {
  readonly message: string;
  readonly path?: readonly (string | number | symbol)[];
};

const ValidationIssueSchema = Schema.Struct({
  message: Schema.String,
  path: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Symbol])),
  ),
});

export class ValidationFailedError extends Schema.TaggedError<ValidationFailedError>()(
  "ValidationFailedError",
  {
    filePath: Schema.String,
    issues: Schema.Array(ValidationIssueSchema),
  },
) {}

export class TransformFailedError extends Schema.TaggedError<TransformFailedError>()(
  "TransformFailedError",
  {
    filePath: Schema.String,
    detail: Schema.String,
  },
) {}

export class ReferenceFailedError extends Schema.TaggedError<ReferenceFailedError>()(
  "ReferenceFailedError",
  {
    filePath: Schema.String,
    fieldPath: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
    detail: Schema.String,
  },
) {}

export class LoaderNotFoundError extends Schema.TaggedError<LoaderNotFoundError>()(
  "LoaderNotFoundError",
  {
    filePath: Schema.String,
  },
) {}

export class LoaderFailedError extends Schema.TaggedError<LoaderFailedError>()(
  "LoaderFailedError",
  {
    filePath: Schema.String,
    detail: Schema.String,
  },
) {}
