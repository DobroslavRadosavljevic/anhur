import type { ContentMeta, DocumentFields } from "../document";
import type { AssetRef } from "../plugin/types";
import type { ResolvedSource } from "./resolve";

/** A content file found by the discover stage. */
export type SourceFile = {
  readonly source: ResolvedSource;
  /** Absolute path. */
  readonly absPath: string;
  readonly id: string;
  readonly locale: string | undefined;
  readonly meta: ContentMeta;
};

/** Side effects a document had while its fields were compiled. */
export type DocumentEffects = {
  readonly assets: readonly AssetRef[];
  /** Absolute files the compiled output depends on (besides the source file). */
  readonly dependencies: readonly string[];
  /** On-disk field cache entries used, kept alive by garbage collection. */
  readonly cacheKeys: readonly string[];
};

/** A document after loading, field compilation and Zod validation. */
export type ValidatedDocument = {
  readonly file: SourceFile;
  /** SHA-256 of the raw file text. */
  readonly hash: string;
  /** `draft: true` in the file or in the validated data: never published. */
  readonly draft: boolean;
  readonly data: DocumentFields;
  readonly effects: DocumentEffects;
};

/** A document that is part of the output (after transform / relations / prepare). */
export type FinalDocument = {
  readonly file: SourceFile;
  data: DocumentFields;
  readonly effects: DocumentEffects;
};

/** Documents of one source at some stage. */
export type SourceDocuments<TDocument> = {
  readonly source: ResolvedSource;
  documents: TDocument[];
};
