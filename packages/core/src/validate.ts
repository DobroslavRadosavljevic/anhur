import { Effect } from "effect";
import type { z } from "zod";
import type { BuildContext } from "./build-context";
import { withBuildContext } from "./build-context";
import type { ContentSchema, AnhurConfig } from "./config";
import { withDocumentMeta, type DocumentMeta } from "./document-meta";
import { ValidationFailedError, type ValidationIssue } from "./errors-content";

export type ValidateDocumentInput = {
  schema: ContentSchema;
  input: unknown;
  filePath: string;
  id: string;
  config: AnhurConfig;
  buildContext: BuildContext;
  content?: string;
  sourceName: string;
  locale?: string;
};

export const validateWithSchema = <TSchema extends ContentSchema>(options: {
  schema: TSchema;
  input: unknown;
  filePath: string;
  id: string;
  config: AnhurConfig;
  buildContext: BuildContext;
  content?: string;
  sourceName: string;
  locale?: string;
}): Effect.Effect<z.infer<TSchema>, ValidationFailedError> =>
  Effect.tryPromise({
    try: async () => {
      const meta: DocumentMeta = {
        path: options.filePath,
        id: options.id,
        content: options.content,
        input: options.input,
        sourceName: options.sourceName,
        locale: options.locale,
        config: options.config,
      };

      const result = await withBuildContext(options.buildContext, () =>
        withDocumentMeta(meta, () =>
          options.schema.safeParseAsync(options.input),
        ),
      );

      if (!result.success) {
        const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path,
        }));
        throw new ValidationFailedError({
          filePath: options.filePath,
          issues,
        });
      }

      return result.data;
    },
    catch: (cause) => {
      if (cause instanceof ValidationFailedError) return cause;
      return new ValidationFailedError({
        filePath: options.filePath,
        issues: [{ message: String(cause) }],
      });
    },
  });
