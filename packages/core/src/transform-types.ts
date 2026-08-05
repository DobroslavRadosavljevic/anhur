import type { AnyContent, TransformDocument } from "./config";
import type { SkippedSignal } from "./skip";

/**
 * Second argument to collection/singleton `transform` hooks.
 * Use `documents()` for cross-source joins after all content is validated.
 */
export type TransformContext = {
  /**
   * Return validated documents for another content source (after reference
   * resolution). Pass the collection/singleton definition or its `name`.
   */
  documents: (source: AnyContent | string) => TransformDocument[];
  /**
   * Drop this document from generated output (e.g. drafts).
   * Return the signal from `transform`.
   */
  skip: (reason?: string) => SkippedSignal;
};

export type DocumentTransform = (
  document: TransformDocument,
  context: TransformContext,
) =>
  | TransformDocument
  | SkippedSignal
  | Promise<TransformDocument | SkippedSignal>;

/** Snapshot passed to prepare / complete / onSuccess hooks. */
export type BuiltContentSnapshot = {
  name: string;
  type: "collection" | "singleton";
  documents: TransformDocument[];
};

export type PrepareHook = (
  sources: BuiltContentSnapshot[],
) => void | Promise<void>;

export type CompleteHook = (
  sources: BuiltContentSnapshot[],
) => void | Promise<void>;

export type CollectionOnSuccess = (
  documents: TransformDocument[],
) => void | Promise<void>;

export type SingletonOnSuccess = (
  document: TransformDocument | undefined,
) => void | Promise<void>;
