import type { InferDocument } from "./infer";
import type { AnyContent, ScopeContext } from "./types";

/** `ScopeContext` whose `documents()` is typed for the content tuple. */
export type TypedScopeContext<TContent extends readonly AnyContent[]> = {
  readonly documents: <TSource extends TContent[number]>(
    source: TSource,
  ) => readonly InferDocument<TSource>[];
} & ScopeContext;

/**
 * A scope as `defineConfig` checks it: `where` keys are source names, and
 * each callback gets that source's document type (references are still
 * ids: the scope decides before they are resolved).
 */
export type ScopeInput<TContent extends readonly AnyContent[]> = {
  /** Lowercase letters, digits and dashes, starting with a letter. */
  readonly name: string;
  /** Output of this scope, relative to the config file. Its own folder. */
  readonly outputDir: string;
  /**
   * Per source: keep a document when the callback returns `true`. Sources
   * that are not listed keep every document.
   */
  readonly where?: {
    readonly [K in TContent[number]["name"]]?: (
      document: InferDocument<Extract<TContent[number], { name: K }>>,
      context: TypedScopeContext<TContent>,
    ) => boolean;
  };
};
