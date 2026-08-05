/** Symbol marking a transform result that should drop the document. */
export const skippedSymbol: unique symbol = Symbol.for("anhur.skipped");

export type SkippedSignal = {
  readonly [skippedSymbol]: true;
  readonly reason?: string;
};

export function isSkippedSignal(value: unknown): value is SkippedSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SkippedSignal)[skippedSymbol] === true
  );
}

export function createSkippedSignal(reason?: string): SkippedSignal {
  return { [skippedSymbol]: true, reason };
}
