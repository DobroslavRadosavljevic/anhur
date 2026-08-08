import type { AnyContent, ContentMeta, TransformDocument } from "./config";
import { createSkippedSignal } from "./skip";
import type { TransformContext } from "./transform-types";

export type {
  BuiltContentSnapshot,
  CollectionOnSuccess,
  CompleteContext,
  CompleteHook,
  DocumentTransform,
  PrepareHook,
  SingletonOnSuccess,
  TransformContext,
} from "./transform-types";

export type TransformableSource = {
  source: { name: string };
  documents: readonly {
    data: Record<string, unknown>;
    _meta: ContentMeta;
  }[];
};

/**
 * Build the context passed as the second argument to `transform` hooks.
 */
export function createTransformContext(
  built: readonly TransformableSource[],
): TransformContext {
  const byName = new Map(
    built.map((item) => [item.source.name, item] as const),
  );

  return {
    documents(source: AnyContent | string) {
      const name = typeof source === "string" ? source : source.name;
      const item = byName.get(name);
      if (!item) {
        throw new Error(
          `Unknown content source "${name}" in transform context. Register it in defineConfig({ content }).`,
        );
      }
      return item.documents.map(
        (doc) =>
          ({
            ...doc.data,
            _meta: doc._meta,
          }) as TransformDocument,
      );
    },
    skip: createSkippedSignal,
  };
}

export function toTransformDocument(
  data: Record<string, unknown>,
  meta: ContentMeta,
): TransformDocument {
  return { ...data, _meta: meta } as TransformDocument;
}

export function toBuiltSnapshots(
  built: readonly TransformableSource[],
): import("./transform-types").BuiltContentSnapshot[] {
  return built.map((item) => ({
    name: item.source.name,
    type:
      "type" in item.source && item.source.type === "singleton"
        ? ("singleton" as const)
        : ("collection" as const),
    documents: item.documents.map((doc) =>
      toTransformDocument(doc.data, doc._meta),
    ),
  }));
}
