/**
 * True when both lists hold the same items, by identity, in the same
 * order. The stages remember their work by the documents it was made
 * from: an unchanged document is the same object in every build.
 */
export function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
