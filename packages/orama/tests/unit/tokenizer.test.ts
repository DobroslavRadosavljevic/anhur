import { describe, expect, it } from "vitest";
import { loadStemmer, type Stemmer } from "../../src/stemmers";
import { createUnicodeTokenizer } from "../../src/tokenizer";

/** Tokens as stored in the index (Orama passes the property name). */
function indexTokens(
  locale: string,
  text: string,
  stemmer?: Stemmer,
): readonly string[] {
  return createUnicodeTokenizer(locale, stemmer).tokenize(
    text,
    undefined,
    "title",
    false,
  );
}

/** Tokens of a query (Orama passes no property name). */
function queryTokens(
  locale: string,
  text: string,
  stemmer?: Stemmer,
): readonly string[] {
  return createUnicodeTokenizer(locale, stemmer).tokenize(text);
}

describe("createUnicodeTokenizer", () => {
  it("splits any script into folded words", () => {
    expect(indexTokens("sr", "Здраво, свете! Čaša")).toEqual([
      "здраво",
      "свете",
      "casa",
    ]);
    expect(indexTokens("el", "Καλημέρα κόσμε")).toEqual(["καλημερα", "κοσμε"]);
  });

  it("drops punctuation and duplicates, and handles empty input", () => {
    expect(indexTokens("en", "a -- a, b...")).toEqual(["a", "b"]);
    expect(indexTokens("en", "")).toEqual([]);
  });

  it("falls back to English for an unknown locale", () => {
    expect(indexTokens("not a locale", "Hello world")).toEqual([
      "hello",
      "world",
    ]);
  });

  it("keeps Indic vowel signs and Thai marks (only Latin-style accents are stripped)", () => {
    const hindi = ["काम", "कम", "कमी"].map((word) => indexTokens("hi", word));
    expect(new Set(hindi.map((tokens) => tokens.join()))).toHaveProperty(
      "size",
      3,
    );
    expect(indexTokens("hi", "काम")).toEqual(["काम"]);
    // Thai tone mark (U+0E49) kept; "น้ำ" ≠ "นา".
    expect(indexTokens("th", "น้ำ")[0]).toContain("\u0E49");
    expect(indexTokens("th", "น้ำ")).not.toEqual(indexTokens("th", "นา"));
    expect(indexTokens("vi", "Tiếng Việt")).toEqual(["tieng", "viet"]);
  });

  it("indexes CJK text as bigrams so words inside compounds match", () => {
    expect(indexTokens("ja", "東京タワー")).toEqual([
      "東京",
      "京タ",
      "タワ",
      "ワー",
      "ー",
    ]);
    const stored = new Set(indexTokens("ja", "東京タワーへようこそ"));
    for (const query of ["タワー", "東京", "ようこそ", "タ"]) {
      for (const token of queryTokens("ja", query)) {
        expect([...stored].some((word) => word.startsWith(token))).toBe(true);
      }
    }
    expect(queryTokens("ja", "タワー")).toEqual(["タワ", "ワー"]);
    expect(queryTokens("zh", "京")).toEqual(["京"]);
    expect(indexTokens("ko", "서울타워")).toContain("타워");
  });

  it("treats spelling variants as the same token", () => {
    const same = (locale: string, a: string, b: string) =>
      expect(indexTokens(locale, a)).toEqual(queryTokens(locale, b));
    same("en", "don’t", "don't");
    same("en", "donʼt", "dont");
    same("de", "Straße", "strasse");
    same("tr", "ISTANBUL", "istanbul");
    same("en", "İstanbul", "istanbul");
    same("en", "1,000", "1000");
    same("de", "1.000", "1000");
    same("en", "ＡＢＣ", "abc");
    same("el", "ΚΟΣΜΟΣ", "κοσμοσ");
  });

  it("stems with the given stemmer, before removing accents", async () => {
    const german = await loadStemmer("german");
    expect(indexTokens("de", "Häuser", german)).toEqual(
      queryTokens("de", "Hausern", german),
    );
    const english = await loadStemmer("english");
    expect(queryTokens("en", "running runs", english)).toEqual(["run"]);
  });

  it("does not grow Orama's cache, and stays correct past its own bound", () => {
    const tokenizer = createUnicodeTokenizer("en");
    for (let index = 0; index < 5000; index += 1) {
      expect(tokenizer.tokenize(`word${index}`)).toEqual([`word${index}`]);
    }
    expect(tokenizer.normalizationCache.size).toBe(0);
    expect(tokenizer.tokenize("word0 Word1")).toEqual(["word0", "word1"]);
  });
});
