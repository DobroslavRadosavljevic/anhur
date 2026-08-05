import {
  collectionConstName,
  generateCollectionArrayTypeName,
  generateDocumentTypeName,
  generateTypeName,
  singletonConstName,
  type AnyCollection,
  type AnySingleton,
  type ContentMeta,
  type GenerateSplit,
  type ListSort,
} from "./config";

export const DEFAULT_LIST_OMIT = ["body"] as const;
export const DEFAULT_LOOKUP_BY = ["slug"] as const;

/** `posts` → `getPost`, `authors` → `getAuthor`, `changelog` → `getChangelog`. */
export function collectionGetterName(collectionName: string): string {
  return `get${generateDocumentTypeName(collectionName)}`;
}

/** Safe module basename: `en__hello` (locale + document id). */
export function documentModuleBasename(
  locale: string | undefined,
  id: string,
): string {
  const loc = locale ?? "default";
  const safeId = id.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${loc}__${safeId}`;
}

export function documentLookupKey(
  locale: string | undefined,
  key: string,
): string {
  return `${locale ?? "default"}:${key}`;
}

export function resolveListOmit(
  listOmit: readonly string[] | undefined,
): readonly string[] {
  return listOmit ?? DEFAULT_LIST_OMIT;
}

export function toDocumentExport(
  data: Record<string, unknown>,
  meta: ContentMeta,
): Record<string, unknown> {
  return {
    ...data,
    _meta: meta,
  };
}

/** List row: full document minus omitted heavy fields. */
export function toListExport(
  data: Record<string, unknown>,
  meta: ContentMeta,
  listOmit: readonly string[],
): Record<string, unknown> {
  const full = toDocumentExport(data, meta);
  if (listOmit.length === 0) return full;
  const light: Record<string, unknown> = { ...full };
  for (const key of listOmit) {
    delete light[key];
  }
  return light;
}

export function omitKeysUnionType(keys: readonly string[]): string {
  if (keys.length === 0) return "never";
  return keys.map((k) => JSON.stringify(k)).join(" | ");
}

export type ResolvedCollectionGenerate = {
  listName: string;
  getterName: string;
  arrayTypeName: string;
  listItemTypeName: string;
  split: GenerateSplit;
  listOmit: readonly string[];
  lookupBy: readonly string[];
  emitIds: boolean;
  emitSlugs: boolean;
  listSort: ListSort | undefined;
  /** Whether to emit `documents/` + async getter. */
  emitDocuments: boolean;
};

export type ResolvedSingletonGenerate = {
  exportName: string;
  getterName: string;
  variantsName: string;
  split: GenerateSplit;
  emitAll: boolean;
  emitDocuments: boolean;
};

export function resolveCollectionGenerate(
  source: AnyCollection,
): ResolvedCollectionGenerate {
  const g = source.generate;
  const split: GenerateSplit = g?.split ?? "light";
  const documentType = source.typeName;
  const listOmit =
    split === "full" ? [] : resolveListOmit(g?.listOmit ?? source.listOmit);

  return {
    listName: g?.listName ?? collectionConstName(source.name),
    getterName: g?.getterName ?? collectionGetterName(source.name),
    arrayTypeName:
      g?.arrayTypeName ??
      generateCollectionArrayTypeName(source.name, documentType),
    listItemTypeName: g?.listItemTypeName ?? `${documentType}ListItem`,
    split,
    listOmit,
    lookupBy: g?.lookupBy ?? DEFAULT_LOOKUP_BY,
    emitIds: g?.emitIds ?? false,
    emitSlugs: g?.emitSlugs ?? false,
    listSort: g?.listSort,
    emitDocuments: split === "light",
  };
}

export function resolveSingletonGenerate(
  source: AnySingleton,
  localized: boolean,
): ResolvedSingletonGenerate {
  const g = source.generate;
  const split: GenerateSplit = g?.split ?? "light";
  const pascal = generateTypeName(source.name);

  return {
    exportName: g?.exportName ?? singletonConstName(source.name),
    getterName: g?.getterName ?? `get${pascal}`,
    variantsName: g?.variantsName ?? `${source.name}All`,
    split,
    emitAll: localized && (g?.emitAll ?? true),
    emitDocuments: split === "light",
  };
}

export function sortByListSort<T extends Record<string, unknown>>(
  items: readonly T[],
  listSort: ListSort | undefined,
): T[] {
  if (!listSort) return [...items];
  const dir = listSort.order === "desc" ? -1 : 1;
  const { by } = listSort;

  return [...items].sort((a, b) => {
    const av = a[by];
    const bv = b[by];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
}

/** TypeScript string literal union, or `never` when empty. */
export function literalUnionType(values: readonly string[]): string {
  const unique = [...new Set(values.filter((v) => v.length > 0))].sort();
  if (unique.length === 0) return "never";
  return unique.map((v) => JSON.stringify(v)).join(" | ");
}

export function getterQueryTypeFields(lookupBy: readonly string[]): string {
  const names = new Set<string>(["locale", "id"]);
  for (const key of lookupBy) {
    if (key === "id" || key === "locale") continue;
    names.add(key);
  }
  return [...names].map((name) => `${name}?: string`).join("; ");
}

/**
 * Resolve the lookup key part from a getter query object.
 * Generated getters inline equivalent logic.
 */
export function pickLookupKeyPart(
  query: Record<string, unknown>,
  lookupBy: readonly string[],
): string | undefined {
  if (typeof query.id === "string" && query.id.length > 0) {
    return query.id;
  }
  for (const field of lookupBy) {
    if (field === "id") continue;
    const value = query[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function collectStringFieldValues(
  documents: readonly { data: Record<string, unknown> }[],
  field: string,
): string[] {
  const values: string[] = [];
  for (const doc of documents) {
    const value = doc.data[field];
    if (typeof value === "string" && value.length > 0) {
      values.push(value);
    }
  }
  return values;
}

export function collectDocumentIds(
  documents: readonly { _meta: ContentMeta }[],
): string[] {
  return documents.map((d) => d._meta.id);
}
