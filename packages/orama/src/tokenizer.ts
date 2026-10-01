import type { Tokenizer } from "@orama/orama";
import type { Stemmer, StemmerLanguage } from "./stemmers";

/** How an index tokenizes text. Stored in the index so search uses the same rules. */
export type TokenizerSpec = {
  /** Locale for word segmentation and lowercasing. */
  readonly locale: string;
  /** Stemming language (`@orama/stemmers`); no stemming when absent. */
  readonly stemmer?: StemmerLanguage;
};

/** Folded words kept per tokenizer (bounded, least recently used dropped). */
const CACHE_SIZE = 2048;

/** Runs of Han, Hiragana, Katakana or Hangul (languages written without spaces between words). */
const CJK_RUN =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]+/gu;
/** Apostrophes: `don’t`, `don't` and `dont` are the same token. */
const APOSTROPHES = /['‘’ʼ＇]/g;
/** Group / decimal separators between digits: `1,000` = `1.000` = `1000`. */
const DIGIT_SEPARATORS = /(?<=\p{Nd})[.,٫٬](?=\p{Nd})/gu;
/** Combining diacritical marks (U+0300–U+036F) only: Indic, Thai, … marks are letters, not accents. */
const DIACRITICS = /[̀-ͯ]/g;

function segmenter(locale: string): Intl.Segmenter {
  try {
    return new Intl.Segmenter(locale, { granularity: "word" });
  } catch {
    return new Intl.Segmenter("en", { granularity: "word" });
  }
}

function lowercase(word: string, locale: string): string {
  try {
    return word.toLocaleLowerCase(locale);
  } catch {
    return word.toLowerCase();
  }
}

/** Lowercase and unify spellings before stemming. */
function normalize(word: string, locale: string): string {
  return lowercase(word.normalize("NFKC"), locale)
    .replace(APOSTROPHES, "")
    .replace(DIGIT_SEPARATORS, "")
    .replaceAll("ß", "ss");
}

/** Strip accents (`čaša` → `casa`) and unify letter variants, after stemming. */
function fold(word: string): string {
  return word
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .normalize("NFC")
    .replaceAll("ı", "i")
    .replaceAll("ς", "σ");
}

/**
 * Character bigrams of a CJK run, so words inside compounds match
 * (`東京タワー` → `東京 京タ タワ ワー`). At index time the last character is
 * added as well, so every character starts some token (prefix search finds
 * one-character queries). A one-character query is that character.
 */
function cjkTokens(run: string, query: boolean): string[] {
  const chars = Array.from(run);
  if (chars.length === 1) return chars;
  const tokens: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(`${chars[index]}${chars[index + 1]}`);
  }
  if (!query) tokens.push(chars.at(-1) ?? "");
  return tokens;
}

function wordTokens(
  word: string,
  locale: string,
  stemmer: Stemmer | undefined,
  query: boolean,
): string[] {
  const normalized = normalize(word, locale);
  const tokens: string[] = [];
  const addWord = (part: string) => {
    const folded = fold(stemmer ? stemmer(part) : part);
    if (folded.length > 0) tokens.push(folded);
  };
  let last = 0;
  for (const match of normalized.matchAll(CJK_RUN)) {
    if (match.index > last) addWord(normalized.slice(last, match.index));
    tokens.push(...cjkTokens(match[0], query));
    last = match.index + match[0].length;
  }
  if (last < normalized.length) addWord(normalized.slice(last));
  return tokens;
}

/**
 * Tokenizer that works for every script (Latin, Cyrillic, Greek, Indic,
 * CJK, …): words from `Intl.Segmenter`, lowercased, optionally stemmed,
 * without accents; CJK text as character bigrams. Orama calls `tokenize`
 * without a property name for queries.
 */
export function createUnicodeTokenizer(
  locale: string,
  stemmer?: Stemmer,
): Tokenizer {
  const words = segmenter(locale);
  const cache = new Map<string, readonly string[]>();
  const tokensOf = (word: string, query: boolean): readonly string[] => {
    const key = `${query ? "q" : "i"}${word}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const tokens = wordTokens(word, locale, stemmer, query);
    cache.set(key, tokens);
    if (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    return tokens;
  };
  return {
    language: "english",
    // Orama's own cache is unused: folding is cached above, with a bound.
    normalizationCache: new Map(),
    tokenize: (raw, _language, prop) => {
      if (raw.length === 0) return [];
      const query = prop === undefined;
      const tokens = new Set<string>();
      for (const segment of words.segment(raw)) {
        if (!segment.isWordLike) continue;
        for (const token of tokensOf(segment.segment, query)) tokens.add(token);
      }
      return [...tokens];
    },
  };
}
