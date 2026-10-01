/** Turns a lowercase word into its stem (`"running"` → `"run"`). */
export type Stemmer = (word: string) => string;

type StemmerModule = { readonly stemmer: Stemmer };

/**
 * Stemmers from `@orama/stemmers`, one dynamic import each, so a bundle
 * only loads the language an index uses.
 */
const STEMMERS = {
  arabic: () => import("@orama/stemmers/arabic"),
  armenian: () => import("@orama/stemmers/armenian"),
  bulgarian: () => import("@orama/stemmers/bulgarian"),
  danish: () => import("@orama/stemmers/danish"),
  dutch: () => import("@orama/stemmers/dutch"),
  english: () => import("@orama/stemmers/english"),
  finnish: () => import("@orama/stemmers/finnish"),
  french: () => import("@orama/stemmers/french"),
  german: () => import("@orama/stemmers/german"),
  greek: () => import("@orama/stemmers/greek"),
  hungarian: () => import("@orama/stemmers/hungarian"),
  indian: () => import("@orama/stemmers/indian"),
  indonesian: () => import("@orama/stemmers/indonesian"),
  irish: () => import("@orama/stemmers/irish"),
  italian: () => import("@orama/stemmers/italian"),
  lithuanian: () => import("@orama/stemmers/lithuanian"),
  nepali: () => import("@orama/stemmers/nepali"),
  norwegian: () => import("@orama/stemmers/norwegian"),
  portuguese: () => import("@orama/stemmers/portuguese"),
  romanian: () => import("@orama/stemmers/romanian"),
  russian: () => import("@orama/stemmers/russian"),
  sanskrit: () => import("@orama/stemmers/sanskrit"),
  serbian: () => import("@orama/stemmers/serbian"),
  spanish: () => import("@orama/stemmers/spanish"),
  swedish: () => import("@orama/stemmers/swedish"),
  tamil: () => import("@orama/stemmers/tamil"),
  turkish: () => import("@orama/stemmers/turkish"),
  ukrainian: () => import("@orama/stemmers/ukrainian"),
} satisfies { readonly [language: string]: () => Promise<StemmerModule> };

/** Languages with a stemmer (`languages` values in `orama()`). */
export type StemmerLanguage = keyof typeof STEMMERS;

/** Every supported stemming language, sorted. */
export const STEMMER_LANGUAGES: readonly StemmerLanguage[] =
  Object.keys(STEMMERS).filter(isStemmerLanguage);

export function isStemmerLanguage(value: string): value is StemmerLanguage {
  return Object.hasOwn(STEMMERS, value);
}

/** Load the stemmer of a language (only that language's code). */
export async function loadStemmer(language: StemmerLanguage): Promise<Stemmer> {
  const module = await STEMMERS[language]();
  return module.stemmer;
}
