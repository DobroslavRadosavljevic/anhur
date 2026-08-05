import type { AnyContent } from "./config";
import type { DocumentTransform } from "./transform-types";
import {
  createTransformContext,
  toTransformDocument,
  type TransformableSource,
} from "./transform";
import { TransformFailedError } from "./errors";
import { isSkippedSignal } from "./skip";
import { Effect } from "effect";

type TransformSource = TransformableSource & {
  source: AnyContent;
};

export function applyDocumentTransforms(
  built: TransformSource[],
): Effect.Effect<void, TransformFailedError> {
  const context = createTransformContext(built);

  return Effect.gen(function* () {
    for (const item of built) {
      const transform = item.source.transform as DocumentTransform | undefined;
      if (!transform) {
        // Still honor draft: true without a custom transform
        item.documents = item.documents.filter(
          (doc) => doc.data.draft !== true,
        );
        continue;
      }

      const nextDocs = yield* Effect.forEach(
        item.documents,
        (doc) =>
          Effect.tryPromise({
            try: async () => {
              if (doc.data.draft === true) {
                return { skipped: true as const, reason: "draft" };
              }
              const result = await transform(
                toTransformDocument(doc.data, doc._meta),
                context,
              );
              if (isSkippedSignal(result)) {
                return {
                  skipped: true as const,
                  reason: result.reason,
                };
              }
              const { _meta: nextMeta, ...nextData } = result;
              return {
                skipped: false as const,
                doc: {
                  data: nextData as Record<string, unknown>,
                  _meta: nextMeta,
                },
              };
            },
            catch: (cause) =>
              new TransformFailedError({
                filePath: doc._meta.filePath,
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        { concurrency: 1 },
      );

      item.documents = nextDocs
        .filter((row) => !row.skipped)
        .map((row) => {
          if (row.skipped) {
            throw new Error("unreachable");
          }
          return row.doc;
        });
    }
  });
}
