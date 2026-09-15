import type { AnyContent, ContentMeta, TransformDocument } from "./config";
import { createSkippedSignal } from "./skip";
import type { BuiltContentSnapshot, TransformContext } from "./transform-types";
import { Predicate } from "effect";
import type { DocumentFields } from "./document-fields";

export type TransformableSource = {
  source: { name: string };
  documents: readonly {
    data: DocumentFields;
    _meta: ContentMeta;
  }[];
};

function sourceName(source: AnyContent | string): string {
  return Predicate.isString(source) ? source : source.name;
}

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
      const name = sourceName(source);
      const item = byName.get(name);
      if (!item) {
        throw new Error(
          `Unknown content source "${name}" in transform context. Register it in defineConfig({ content }).`,
        );
      }
      return item.documents.map((doc) =>
        toTransformDocument(doc.data, doc._meta),
      );
    },
    skip: createSkippedSignal,
  };
}

export function toTransformDocument(
  data: DocumentFields,
  meta: ContentMeta,
): TransformDocument {
  return { ...data, _meta: meta };
}

export function toBuiltSnapshots(
  built: readonly TransformableSource[],
): BuiltContentSnapshot[] {
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
