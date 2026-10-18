import type { TransformDocument } from "../define/types";
import {
  isPlainObject,
  setField,
  type DocumentFields,
  type DocumentValue,
} from "../document";
import { deepFreeze } from "./freeze";
import type { FinalDocument, ValidatedDocument } from "./types";

/**
 * Exported form of documents: one deep-frozen object per document, made
 * once.
 */
const exported = new WeakMap<
  FinalDocument | ValidatedDocument,
  TransformDocument
>();

function withMeta(
  document: FinalDocument | ValidatedDocument,
): TransformDocument {
  let known = exported.get(document);
  if (!known) {
    // The data is deep-frozen already: this freezes the new object, and
    // makes the whole of it known as deep-frozen.
    known = deepFreeze({ ...document.data, _meta: document.file.meta });
    exported.set(document, known);
  }
  return known;
}

/**
 * Final document as exported: data + `_meta`. The same frozen object is
 * returned for the same document, so hooks, plugins and later builds can
 * tell an unchanged document by identity.
 */
export function toExport(document: FinalDocument): TransformDocument {
  return withMeta(document);
}

/** Validated document as `ctx.documents()` shows it: data + `_meta`, frozen. */
export function toSnapshot(document: ValidatedDocument): TransformDocument {
  return withMeta(document);
}

function isEmbedded(value: DocumentValue): value is DocumentFields {
  return isPlainObject(value) && isPlainObject(value._meta);
}

function lighten(
  value: DocumentValue,
  omit: ReadonlySet<string>,
): DocumentValue {
  if (Array.isArray(value)) {
    const items: readonly DocumentValue[] = value;
    return items.map((item) => lighten(item, omit));
  }
  if (isEmbedded(value)) return omitDeep(value, omit);
  return value;
}

/**
 * Remove light-list keys from a document and from documents embedded in it
 * (objects with `_meta`), matching `OmitListFields` in generated types.
 */
export function omitDeep(
  document: DocumentFields,
  omit: ReadonlySet<string>,
): DocumentFields {
  if (omit.size === 0) return document;
  const out: DocumentFields = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === "_meta") {
      out[key] = value;
      continue;
    }
    if (omit.has(key)) continue;
    setField(out, key, lighten(value, omit));
  }
  return out;
}

/** Light-list rows by document, for one list of omitted keys. */
type RowMemo = WeakMap<FinalDocument, DocumentFields>;

const rowMemos = new WeakMap<readonly string[], RowMemo>();

/**
 * Light-list row of a final document. Rows are remembered per `omit` list
 * (a list that lives as long as the loaded config) and frozen, so an
 * unchanged document gives the same row object in every build.
 */
export function toListRow(
  document: FinalDocument,
  omit: readonly string[],
): DocumentFields {
  let memo = rowMemos.get(omit);
  if (!memo) {
    memo = new WeakMap();
    rowMemos.set(omit, memo);
  }
  let row = memo.get(document);
  if (!row) {
    row = deepFreeze(omitDeep(toExport(document), new Set(omit)));
    memo.set(document, row);
  }
  return row;
}
