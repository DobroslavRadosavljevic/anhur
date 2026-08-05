import type { ContentMeta } from "./config";
import { isReferenceMarker } from "./schema/reference";

export type ReferenceBy = "id" | "slug";

export type ReferenceResolveFailure = {
  filePath: string;
  fieldPath: readonly (string | number)[];
  detail: string;
};

type RelationDocument = {
  data: Record<string, unknown>;
  _meta: ContentMeta;
};

type RelationSource = {
  source: { name: string };
  documents: RelationDocument[];
};

function lookupKey(doc: RelationDocument, by: ReferenceBy): string | undefined {
  if (by === "id") return doc._meta.id;
  const slug = doc.data.slug;
  return typeof slug === "string" ? slug : undefined;
}

function findReferencedDocument(
  built: readonly RelationSource[],
  collection: string,
  by: ReferenceBy,
  value: string,
  locale?: string,
): { ok: true; doc: RelationDocument } | { ok: false; detail: string } {
  const source = built.find((item) => item.source.name === collection);
  if (!source) {
    return {
      ok: false,
      detail: `referenced collection/singleton "${collection}" is not registered`,
    };
  }

  const matches = source.documents.filter(
    (doc) => lookupKey(doc, by) === value,
  );

  if (matches.length === 0) {
    return {
      ok: false,
      detail: `no ${collection} with ${by} "${value}"`,
    };
  }

  if (locale !== undefined) {
    const sameLocale = matches.find((d) => d._meta.locale === locale);
    if (sameLocale) return { ok: true, doc: sameLocale };

    const monolingual = matches.find((d) => d._meta.locale === undefined);
    if (monolingual) return { ok: true, doc: monolingual };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      detail: `ambiguous ${collection} ${by} "${value}" (${matches.length} matches)`,
    };
  }

  return { ok: true, doc: matches[0]! };
}

function resolveValue(
  value: unknown,
  built: readonly RelationSource[],
  filePath: string,
  locale: string | undefined,
  fieldPath: Array<string | number>,
  failures: ReferenceResolveFailure[],
): unknown {
  if (isReferenceMarker(value)) {
    const found = findReferencedDocument(
      built,
      value.collection,
      value.by,
      value.value,
      locale,
    );
    if (!found.ok) {
      failures.push({
        filePath,
        fieldPath: [...fieldPath],
        detail: found.detail,
      });
      return value.value;
    }
    if (value.embed) {
      return {
        ...found.doc.data,
        _meta: found.doc._meta,
      };
    }
    return value.value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveValue(
        item,
        built,
        filePath,
        locale,
        [...fieldPath, index],
        failures,
      ),
    );
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Do not walk into already-embedded `_meta` trees from other docs.
    if ("_meta" in obj && typeof obj._meta === "object") {
      // Still resolve sibling fields on this object.
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if (key === "_meta") {
        out[key] = child;
        continue;
      }
      out[key] = resolveValue(
        child,
        built,
        filePath,
        locale,
        [...fieldPath, key],
        failures,
      );
    }
    return out;
  }

  return value;
}

/**
 * Walk collected documents, validate `s.reference()` markers, and embed when asked.
 */
export function resolvePendingReferences(
  built: RelationSource[],
): ReferenceResolveFailure[] {
  const failures: ReferenceResolveFailure[] = [];

  for (const item of built) {
    for (const doc of item.documents) {
      const next = resolveValue(
        doc.data,
        built,
        doc._meta.filePath,
        doc._meta.locale,
        [],
        failures,
      );
      if (next !== null && typeof next === "object" && !Array.isArray(next)) {
        doc.data = next as Record<string, unknown>;
      }
    }
  }

  return failures;
}
