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
} from "./config";
import { createTransformContext } from "./transform";

export type ViewBuiltSource = {
  source: AnyContent;
  documents: readonly {
    data: Record<string, unknown>;
    _meta: ContentMeta;
  }[];
};

export type BuiltView = {
  kind: "view";
  derived: AnyView;
  items: Record<string, unknown>[];
};

export type BuiltIndex = {
  kind: "index";
  derived: AnyIndex;
  record: Record<string, Record<string, unknown>>;
};

export type BuiltGroup = {
  kind: "group";
  derived: AnyGroup;
  groups: Array<{
    key: string;
    count: number;
    items: Record<string, unknown>[];
  }>;
};

export type BuiltDerived = BuiltView | BuiltIndex | BuiltGroup;

export function createViewContext(
  built: readonly ViewBuiltSource[],
): ViewContext {
  const transformContext = createTransformContext(built);
  return {
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
): Record<string, unknown>[] {
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
): Record<string, Record<string, unknown>> {
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
  keyed: Array<{ key: string; row: Record<string, unknown> }>,
  generate: AnyIndex["generate"],
): Record<string, Record<string, unknown>> {
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
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });

  if (generate?.limit != null && generate.limit < 0) {
    throw new Error(`generate.limit must be >= 0 (got ${generate.limit}).`);
  }
  const limited =
    generate?.limit != null ? sorted.slice(0, generate.limit) : sorted;

  const record: Record<string, Record<string, unknown>> = {};
  for (const entry of limited) {
    if (entry.key in record) {
      throw new Error(
        `Index "${indexName}" has duplicate key ${JSON.stringify(entry.key)}.`,
      );
    }
    record[entry.key] = entry.row;
  }
  return record;
}

export function resolveGroupEntries(
  group: AnyGroup,
  built: readonly ViewBuiltSource[],
  rootDir: string,
  ctx: ViewContext = createViewContext(built),
): Array<{ key: string; count: number; items: Record<string, unknown>[] }> {
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

  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const entry of projected) {
    const key = entry.key!;
    const list = buckets.get(key);
    if (list) list.push(entry.row);
    else buckets.set(key, [entry.row]);
  }

  const keys = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  return keys.map((key) => {
    const items = finalizeRows(buckets.get(key) ?? [], group.generate);
    return { key, count: items.length, items };
  });
}

type Projectable = {
  name: string;
  where?: (document: any, context: ViewContext) => boolean;
  select?: (document: any, context: ViewContext) => Record<string, unknown>;
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
    keyOf?: (row: Record<string, unknown>) => string;
  },
): Array<{ key?: string; row: Record<string, unknown> }> {
  const isMulti = sources.length > 1;
  const rows: Array<{ key?: string; row: Record<string, unknown> }> = [];

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

      let row: Record<string, unknown> = toListExport(
        doc.data,
        doc._meta,
        listOmit,
        rootDir,
      );
      if (isMulti) {
        row = { ...row, collection: collection.name };
      }

      const key = options?.keyOf ? options.keyOf(row) : undefined;

      if (derived.select) {
        const selected = derived.select(row, ctx);
        if (
          selected === null ||
          typeof selected !== "object" ||
          Array.isArray(selected)
        ) {
          throw new Error(
            `Derived "${derived.name}" select() must return a plain object.`,
          );
        }
        row = selected;
      }
      rows.push({ key, row });
    }
  }

  return rows;
}

function finalizeRows(
  rows: Record<string, unknown>[],
  generate:
    | {
        listSort?: import("./config").ListSort;
        compare?: (
          a: Record<string, unknown>,
          b: Record<string, unknown>,
        ) => number;
        limit?: number;
      }
    | undefined,
): Record<string, unknown>[] {
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
  key: string | ((document: Record<string, unknown>) => string),
  row: Record<string, unknown>,
  derivedName: string,
  kind: "index" | "group",
): string {
  if (typeof key === "function") {
    const value = key(row);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `${kind} "${derivedName}" key function must return a non-empty string.`,
      );
    }
    return value;
  }

  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${kind} "${derivedName}" field ${JSON.stringify(key)} must be a non-empty string on every row (resolved before select).`,
    );
  }
  return value;
}
