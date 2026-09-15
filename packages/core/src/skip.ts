import type { DocumentFields } from "./document-fields";

/** Symbol marking a transform result that should drop the document. */
export const skippedSymbol: unique symbol = Symbol.for("anhur.skipped");

export type SkippedSignal = {
  readonly [skippedSymbol]: true;
  readonly reason?: string;
};

export function isSkippedSignal(
  value: DocumentFields | SkippedSignal,
): value is SkippedSignal {
  return skippedSymbol in value && value[skippedSymbol] === true;
}

export function createSkippedSignal(reason?: string): SkippedSignal {
  return { [skippedSymbol]: true, reason };
}
