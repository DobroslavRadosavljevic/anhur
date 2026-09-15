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
import { isDocumentFields } from "./document-fields";

type TransformSource = TransformableSource & {
  source: AnyContent;
};

export const applyDocumentTransforms = Effect.fn("applyDocumentTransforms")(
  function* (built: TransformSource[]) {
    const context = createTransformContext(built);

    for (const item of built) {
      const transform: DocumentTransform | undefined = item.source.transform;
      if (!transform) {
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
              if (nextData.draft === true) {
                return { skipped: true as const, reason: "draft" };
              }
              if (!isDocumentFields(nextData)) {
                throw new Error("transform must return a document object");
              }
              return {
                skipped: false as const,
                doc: {
                  data: nextData,
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

      item.documents = nextDocs.flatMap((row) =>
        row.skipped ? [] : [row.doc],
      );
    }
  },
);
