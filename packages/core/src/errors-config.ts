import { Schema } from "effect";

export class ConfigNotFoundError extends Schema.TaggedError<ConfigNotFoundError>()(
  "ConfigNotFoundError",
  {
    path: Schema.String,
  },
) {}

export class ConfigInvalidError extends Schema.TaggedError<ConfigInvalidError>()(
  "ConfigInvalidError",
  {
    path: Schema.String,
    detail: Schema.String,
  },
) {}

export class LocalizationConfigError extends Schema.TaggedError<LocalizationConfigError>()(
  "LocalizationConfigError",
  {
    detail: Schema.String,
  },
) {}

export class SingletonMissingError extends Schema.TaggedError<SingletonMissingError>()(
  "SingletonMissingError",
  {
    name: Schema.String,
    path: Schema.String,
  },
) {}

export class SingletonAmbiguousError extends Schema.TaggedError<SingletonAmbiguousError>()(
  "SingletonAmbiguousError",
  {
    name: Schema.String,
    locale: Schema.String,
    files: Schema.Array(Schema.String),
  },
) {}
