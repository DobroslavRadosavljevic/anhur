import { z } from "zod";
import { getDocumentMeta } from "../document-meta";
import { toPlainText } from "./plain-text";

// CJK ranges (simplified time-to-read heuristic)
const cjRanges: Array<[number, number]> = [
  [0x2e80, 0x2fff],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xff66, 0xff9d],
];

function isCjChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return cjRanges.some(([from, to]) => code >= from && code <= to);
}

function latinWordCount(str: string): number {
  const words = str.match(/['\u2019]?([a-zA-Z]+(?:['\u2019]?[a-zA-Z]+)*)/g);
  return words?.length ?? 0;
}

export type DocumentMetadata = {
  /** Estimated reading time in minutes (minimum 1 when non-empty). */
  readingTime: number;
  /** Approximate word count (CJK weighted). */
  wordCount: number;
};

/**
 * Reading time + word count from the field value or document body.
 */
export function metadata(): z.ZodType<DocumentMetadata> {
  return z
    .string()
    .optional()
    .transform((value, ctx): DocumentMetadata => {
      const meta = getDocumentMeta();
      const source = value ?? meta.content ?? "";
      if (source.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "metadata content is empty",
        });
        return z.NEVER;
      }

      const plain = toPlainText(source);
      const avgWpm = 265;
      const latin: string[] = [];
      let cjCount = 0;
      for (const char of plain) {
        if (isCjChar(char)) cjCount += 1;
        else latin.push(char);
      }
      const wordCount = latinWordCount(latin.join("")) + cjCount * 0.56;
      const time = Math.round(wordCount / avgWpm);

      return {
        readingTime: time === 0 ? 1 : time,
        wordCount: Math.round(wordCount),
      };
    }) as unknown as z.ZodType<DocumentMetadata>;
}
