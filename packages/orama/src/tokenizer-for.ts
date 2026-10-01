import type { Tokenizer } from "@orama/orama";
import { isStemmerLanguage, loadStemmer } from "./stemmers";
import { createUnicodeTokenizer, type TokenizerSpec } from "./tokenizer";

/** Orama tokenizer component for a spec (same at build and search time). */
export async function tokenizerFor(spec: TokenizerSpec): Promise<Tokenizer> {
  if (spec.stemmer === undefined) return createUnicodeTokenizer(spec.locale);
  if (!isStemmerLanguage(spec.stemmer)) {
    throw new Error(
      `@anhur/orama: the index uses the unknown stemmer "${String(spec.stemmer)}".`,
    );
  }
  return createUnicodeTokenizer(spec.locale, await loadStemmer(spec.stemmer));
}
