import type { TransformDocument } from "../define/types";
import {
  isPlainObject,
  setField,
  type DocumentFields,
  type DocumentValue,
} from "../document";
import type { FinalDocument } from "./types";

/** Final document as exported: data + `_meta`. */
export function toExport(document: FinalDocument): TransformDocument {
  return { ...document.data, _meta: document.file.meta };
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

/** Light-list row of a final document. */
export function toListRow(
  document: FinalDocument,
  omit: readonly string[],
): DocumentFields {
  return omitDeep(toExport(document), new Set(omit));
}
