import {
  effectiveListOmit,
  resolveCollectionGenerate,
  resolveListOmit,
  sortByListSort,
  toDocumentExport,
  toListExport,
} from "./codegen";
import {
  isCollection,
  isGroup,
  isIndex,
  isView,
  type AnyCollection,
  type AnyContent,
  type AnyDerived,
  type AnyGroup,
  type AnyIndex,
  type AnyView,
  type ContentMeta,
  type ViewContext,
  type ListSort,
} from "./config";
import { createTransformContext } from "./transform";
import { Predicate } from "effect";
import type { DocumentFields } from "./document-fields";
import {
  isDocumentFields,
  isNonEmptyString,
  isNumberNode,
} from "./document-fields";

export type ViewBuiltSource = {
  source: AnyContent;
  documents: readonly {
    data: DocumentFields;
    _meta: ContentMeta;
  }[];
};

export type BuiltView = {
  kind: "view";
  derived: AnyView;
  items: DocumentFields[];
};

export type BuiltIndex = {
  kind: "index";
  derived: AnyIndex;
  record: Record<string, DocumentFields>;
};

export type BuiltGroup = {
  kind: "group";
  derived: AnyGroup;
  groups: Array<{
    key: string;
    count: number;
    items: DocumentFields[];
  }>;
};

export type BuiltDerived = BuiltView | BuiltIndex | BuiltGroup;

export function createViewContext(
  built: readonly ViewBuiltSource[],
): ViewContext {
  const transformContext = createTransformContext(built);
  return {
    // SAFETY: preserves the existing runtime contract for this assignment.
    documents: transformContext.documents as ViewContext["documents"],
  };
}

/**
 * Resolve every entry in `defineConfig({ views })` — lists, indexes, groups.
 */
export function resolveViews(
  derivedEntries: readonly AnyDerived[],
  built: readonly ViewBuiltSource[],
  rootDir: string,
): BuiltDerived[] {
  const ctx = createViewContext(built);
  return derivedEntries.map((entry) => {
    if (isView(entry)) {
      return {
        kind: "view" as const,
        derived: entry,
        items: resolveViewListItems(entry, built, rootDir, ctx),
      };
    }
    if (isIndex(entry)) {
      return {
        kind: "index" as const,
        derived: entry,
        record: resolveIndexRecord(entry, built, rootDir, ctx),
      };
    }
    if (isGroup(entry)) {
      return {
        kind: "group" as const,
        derived: entry,
        groups: resolveGroupEntries(entry, built, rootDir, ctx),
      };
    }
    // SAFETY: preserves the existing runtime contract for this assignment.
    throw new Error(
      `Unknown derived entry "${(entry as AnyDerived).name}" (expected view, index, or group).`,
    );
  });
}

/** @deprecated Use {@link resolveViews}; kept for callers that only need list views. */
export function resolveViewListItems(
  view: AnyView,
  built: readonly ViewBuiltSource[],
  rootDir: string,
  ctx: ViewContext = createViewContext(built),
): DocumentFields[] {
  const rows = collectProjectedRows(view, view.from, built, rootDir, ctx).map(
    (entry) => entry.row,
  );
  return finalizeRows(rows, view.generate);
}

export function resolveIndexRecord(
  index: AnyIndex,
  built: readonly ViewBuiltSource[],
  rootDir: string,
  ctx: ViewContext = createViewContext(built),
): Record<string, DocumentFields> {
  const projected = collectProjectedRows(
    index,
    [index.from],
    built,
    rootDir,
    ctx,
    {
      keyOf: (row) => resolveKey(index.key, row, index.name, "index"),
    },
  );

  return buildIndexRecord(
    index.name,
    projected.map((entry) => ({ key: entry.key!, row: entry.row })),
    index.generate,
  );
}

function buildIndexRecord(
  indexName: string,
  keyed: Array<{ key: string; row: DocumentFields }>,
  generate: AnyIndex["generate"],
) {
  const sorted = [...keyed].sort((a, b) => {
    if (generate?.compare) return generate.compare(a.row, b.row);
    if (!generate?.listSort) return 0;
    const dir = generate.listSort.order === "desc" ? -1 : 1;
    const { by } = generate.listSort;
    const av = a.row[by];
    const bv = b.row[by];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (isNumberNode(av) && isNumberNode(bv)) {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });

  const record: Record<string, DocumentFields> = {};
  const order: string[] = [];
  for (const entry of sorted) {
    if (entry.key in record) {
      throw new Error(
        `Index "${indexName}" has duplicate key ${JSON.stringify(entry.key)}.`,
      );
    }
    record[entry.key] = entry.row;
    order.push(entry.key);
  }

  if (generate?.limit != null && generate.limit < 0) {
    throw new Error(`generate.limit must be >= 0 (got ${generate.limit}).`);
  }
  if (generate?.limit == null) return record;

  const limited: Record<string, DocumentFields> = {};
  for (const key of order.slice(0, generate.limit)) {
    limited[key] = record[key]!;
  }
  return limited;
}

export function resolveGroupEntries(
  group: AnyGroup,
  built: readonly ViewBuiltSource[],
  rootDir: string,
  ctx: ViewContext = createViewContext(built),
): Array<{ key: string; count: number; items: DocumentFields[] }> {
  const projected = collectProjectedRows(
    group,
    [group.from],
    built,
    rootDir,
    ctx,
    {
      keyOf: (row) => resolveKey(group.by, row, group.name, "group"),
    },
  );

  const buckets = new Map<string, DocumentFields[]>();
  for (const entry of projected) {
    const key = entry.key!;
    const list = buckets.get(key);
    if (list) list.push(entry.row);
    else buckets.set(key, [entry.row]);
  }

  const keys = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  return keys.map((key) => {
    const bucket = buckets.get(key) ?? [];
    const items = finalizeRows(bucket, group.generate);
    return { key, count: bucket.length, items };
  });
}

type Projectable = {
  name: string;
  where?: (document: any, context: ViewContext) => boolean;
  select?: (document: any, context: ViewContext) => DocumentFields;
  generate?: {
    listOmit?: readonly string[];
  };
};

function collectProjectedRows(
  derived: Projectable,
  sources: readonly AnyCollection[],
  built: readonly ViewBuiltSource[],
  rootDir: string,
  ctx: ViewContext,
  options?: {
    keyOf?: (row: DocumentFields) => string;
  },
): Array<{ key?: string; row: DocumentFields }> {
  const isMulti = sources.length > 1;
  const rows: Array<{ key?: string; row: DocumentFields }> = [];

  for (const collection of sources) {
    const item = built.find((entry) => entry.source.name === collection.name);
    if (!item || !isCollection(item.source)) {
      throw new Error(
        `Derived "${derived.name}" references unknown collection "${collection.name}".`,
      );
    }

    const sourceGen = resolveCollectionGenerate(item.source);
    const listOmit =
      derived.generate?.listOmit !== undefined
        ? resolveListOmit(derived.generate.listOmit)
        : effectiveListOmit(sourceGen.listOmit, item.documents);

    for (const doc of item.documents) {
      const full = toDocumentExport(doc.data, doc._meta, rootDir);
      const whereInput = isMulti
        ? { ...full, collection: collection.name }
        : full;

      if (derived.where && !derived.where(whereInput, ctx)) {
        continue;
      }

      const key = options?.keyOf ? options.keyOf(whereInput) : undefined;

      let row: DocumentFields;
      if (derived.select) {
        const selected = derived.select(whereInput, ctx);
        if (!isDocumentFields(selected)) {
          throw new Error(
            `Derived "${derived.name}" select() must return a plain object.`,
          );
        }
        row = selected;
      } else {
        row = toListExport(doc.data, doc._meta, listOmit, rootDir);
        if (isMulti) {
          row = { ...row, collection: collection.name };
        }
      }
      rows.push({ key, row });
    }
  }

  return rows;
}

function finalizeRows(
  rows: DocumentFields[],
  generate:
    | {
        listSort?: ListSort;
        compare?: (a: DocumentFields, b: DocumentFields) => number;
        limit?: number;
      }
    | undefined,
): DocumentFields[] {
  let next = generate?.compare
    ? [...rows].sort(generate.compare)
    : sortByListSort(rows, generate?.listSort);

  if (generate?.limit != null) {
    if (generate.limit < 0) {
      throw new Error(`generate.limit must be >= 0 (got ${generate.limit}).`);
    }
    next = next.slice(0, generate.limit);
  }

  return next;
}

function resolveKey(
  key: string | ((document: DocumentFields) => string),
  row: DocumentFields,
  derivedName: string,
  kind: "index" | "group",
): string {
  if (Predicate.isFunction(key)) {
    const value = key(row);
    if (!isNonEmptyString(value)) {
      throw new Error(
        `${kind} "${derivedName}" key function must return a non-empty string.`,
      );
    }
    return value;
  }

  const value = row[key];
  if (!isNonEmptyString(value)) {
    throw new Error(
      `${kind} "${derivedName}" field ${JSON.stringify(key)} must be a non-empty string on every row (resolved before select).`,
    );
  }
  return value;
}
