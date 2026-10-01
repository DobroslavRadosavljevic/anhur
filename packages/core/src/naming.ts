import pluralize from "pluralize";

/**
 * Identifier helpers shared by `define*` defaults and the config resolver.
 * Every generated export / type / file name goes through these so the
 * resolver can validate and detect collisions in one place.
 */

const RESERVED_WORDS = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** True for an ASCII JavaScript identifier that is not a reserved word. */
export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/**
 * ASCII spellings of letters that do not decompose into a base letter plus
 * accents (`ß`, `đ`, `ł`, `æ`, …), and of Cyrillic and Greek letters.
 * Keys are lowercase. Serbian conventions where they differ: `đ` / `ђ` →
 * `dj`, `ћ` → `c`, `љ` → `lj`, `њ` → `nj`, `џ` → `dz`.
 */
const TRANSLITERATION = new Map<string, string>([
  ["ß", "ss"],
  ["đ", "dj"],
  ["ð", "d"],
  ["ł", "l"],
  ["ŀ", "l"],
  ["æ", "ae"],
  ["ø", "o"],
  ["œ", "oe"],
  ["þ", "th"],
  ["ı", "i"],
  ["ħ", "h"],
  ["ŧ", "t"],
  ["ŋ", "ng"],
  ["ĸ", "k"],
  ["ſ", "s"],
  ["ƒ", "f"],
  ["ə", "e"],
  ["ǝ", "e"],
  ["ɛ", "e"],
  ["ɔ", "o"],
  ["ʒ", "z"],
  ["ƶ", "z"],
  ["а", "a"],
  ["б", "b"],
  ["в", "v"],
  ["г", "g"],
  ["ґ", "g"],
  ["д", "d"],
  ["ђ", "dj"],
  ["ѓ", "gj"],
  ["е", "e"],
  ["ё", "yo"],
  ["є", "ye"],
  ["ж", "zh"],
  ["з", "z"],
  ["ѕ", "dz"],
  ["и", "i"],
  ["і", "i"],
  ["ї", "yi"],
  ["й", "y"],
  ["ј", "j"],
  ["к", "k"],
  ["ќ", "kj"],
  ["л", "l"],
  ["љ", "lj"],
  ["м", "m"],
  ["н", "n"],
  ["њ", "nj"],
  ["о", "o"],
  ["п", "p"],
  ["р", "r"],
  ["с", "s"],
  ["т", "t"],
  ["ћ", "c"],
  ["у", "u"],
  ["ў", "u"],
  ["ф", "f"],
  ["х", "h"],
  ["ц", "c"],
  ["ч", "ch"],
  ["џ", "dz"],
  ["ш", "sh"],
  ["щ", "shch"],
  ["ъ", ""],
  ["ы", "y"],
  ["ь", ""],
  ["э", "e"],
  ["ю", "yu"],
  ["я", "ya"],
  ["α", "a"],
  ["β", "v"],
  ["γ", "g"],
  ["δ", "d"],
  ["ε", "e"],
  ["ζ", "z"],
  ["η", "i"],
  ["θ", "th"],
  ["ι", "i"],
  ["κ", "k"],
  ["λ", "l"],
  ["μ", "m"],
  ["ν", "n"],
  ["ξ", "x"],
  ["ο", "o"],
  ["π", "p"],
  ["ρ", "r"],
  ["σ", "s"],
  ["ς", "s"],
  ["τ", "t"],
  ["υ", "y"],
  ["φ", "f"],
  ["χ", "ch"],
  ["ψ", "ps"],
  ["ω", "o"],
]);

function transliterate(value: string): string {
  let out = "";
  for (const char of value) {
    const lower = char.toLowerCase();
    const ascii = TRANSLITERATION.get(lower);
    if (ascii === undefined) {
      out += char;
    } else if (lower !== char && ascii.length > 0) {
      out += ascii.charAt(0).toUpperCase() + ascii.slice(1);
    } else {
      out += ascii;
    }
  }
  return out;
}

/**
 * Fold to ASCII where a spelling is known: transliterate (`ß` → `ss`,
 * `ж` → `zh`), strip accents (`č` → `c`), then transliterate again for
 * letters that only lost their accents (`ά` → `α` → `a`). Case is kept.
 * Letters with no ASCII spelling (CJK, Arabic, …) stay as they are.
 */
function foldToAscii(value: string): string {
  return transliterate(
    transliterate(value)
      .normalize("NFKD")
      .replace(/\p{M}+/gu, ""),
  );
}

/** ASCII word parts of a name (`blog-posts` → `["blog", "posts"]`). */
export function nameWords(name: string): string[] {
  return foldToAscii(name)
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `blog-posts` → `BlogPosts`, `featuredPosts` → `FeaturedPosts`. */
export function pascalCase(name: string): string {
  return nameWords(name).map(capitalize).join("");
}

/** `site-settings` → `siteSettings`, `featuredPosts` → `featuredPosts`. */
export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Singular form of a PascalCase name (`Categories` → `Category`). */
export function singular(pascal: string): string {
  if (pascal.length === 0) return pascal;
  return pluralize.singular(pascal);
}

/** Plural form of a PascalCase name (`Category` → `Categories`, `News` → `News`). */
export function plural(pascal: string): string {
  if (pascal.length === 0) return pascal;
  return pluralize.plural(pascal);
}

/** Default document type name for a collection (`posts` → `Post`). */
export function collectionTypeName(name: string): string {
  return singular(pascalCase(name));
}

/** Default list export for a collection or view (`posts` → `allPosts`). */
export function listExportName(name: string): string {
  return `all${plural(pascalCase(name))}`;
}

/** Default array alias (`Post` → `Posts`, `News` → `NewsList`). */
export function arrayTypeName(typeName: string): string {
  const next = plural(typeName);
  return next === typeName ? `${typeName}List` : next;
}

/** Default singleton type name (`settings` → `Settings`). */
export function singletonTypeName(name: string): string {
  return pascalCase(name);
}

/**
 * ASCII, lowercase, hyphenated slug (`Hello Wörld!` → `hello-world`,
 * `Straße` → `strasse`, `Ђорђе` → `djordje`). Letters and digits with no
 * ASCII spelling are dropped (`你好 world` → `world`); see
 * {@link slugDropsCharacters}. Returns `""` when nothing is left.
 */
export function slugify(value: string): string {
  return foldToAscii(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * True when {@link slugify} would drop letters or digits of `value`
 * because they have no ASCII spelling (`你好`, `مرحبا`), so two different
 * names could get the same slug.
 */
export function slugDropsCharacters(value: string): boolean {
  return /(?![a-z0-9])[\p{L}\p{N}]/u.test(foldToAscii(value).toLowerCase());
}

/** File-system-safe segment for generated paths (`blog_posts` → `blog-posts`). */
export function fileSafeName(name: string): string {
  const slug = slugify(name);
  return slug.length > 0 ? slug : "source";
}
