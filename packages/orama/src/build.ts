import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntegrationRuntimeContext, TransformDocument } from "@anhur/core";
import type {
  AnhurOramaIndex,
  CollectionSearchConfig,
  OramaFieldDatum,
  OramaFieldType,
  OramaIndexDocument,
  OramaIntegrationOptions,
  OramaSchema,
} from "./types";

const BASE_SCHEMA = {
  collection: "string",
  locale: "string",
  /** Content `_meta.id` (Orama's own `id` is a composite key). */
  documentId: "string",
  /** JSON string of the author-chosen hit payload. */
  store: "string",
} as const satisfies OramaSchema;

const BASE_KEYS = new Set(Object.keys(BASE_SCHEMA));

type CollectionConfigMap = {
  [name: string]: CollectionSearchConfig<TransformDocument>;
};

function emptyForType(type: OramaFieldType): OramaFieldDatum {
  switch (type) {
    case "string":
    case "enum":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string[]":
    case "number[]":
    case "boolean[]":
    case "enum[]":
      return [];
  }
}

function mergeSchema(collections: CollectionConfigMap): OramaSchema {
  const merged: OramaSchema = { ...BASE_SCHEMA };
  for (const config of Object.values(collections)) {
    for (const [key, type] of Object.entries(config.schema)) {
      if (BASE_KEYS.has(key)) {
        throw new Error(
          `@anhur/orama: collection schema must not redefine reserved field "${key}".`,
        );
      }
      const existing = merged[key];
      if (existing && existing !== type) {
        throw new Error(
          `@anhur/orama: field "${key}" has conflicting types "${existing}" and "${type}".`,
        );
      }
      merged[key] = type;
    }
  }
  return merged;
}

function searchPropertiesFor(schema: OramaSchema): string[] {
  return Object.entries(schema)
    .filter(([key, type]) => {
      if (BASE_KEYS.has(key)) return false;
      return (
        type === "string" ||
        type === "string[]" ||
        type === "enum" ||
        type === "enum[]"
      );
    })
    .map(([key]) => key);
}

function isCollectionConfigMap<T>(value: T): value is T & CollectionConfigMap {
  return typeof value === "object" && value !== null;
}

type IndexedFields = {
  [field: string]: OramaFieldDatum | undefined;
};

function isIndexedFields<T>(value: T): value is T & IndexedFields {
  return typeof value === "object" && value !== null;
}

function readIndexedValue<T>(
  indexed: T,
  key: string,
): OramaFieldDatum | undefined {
  if (!isIndexedFields(indexed)) return undefined;
  return indexed[key];
}

function toOramaDoc(
  collection: string,
  doc: TransformDocument,
  config: CollectionSearchConfig<TransformDocument>,
  unionSchema: OramaSchema,
): OramaIndexDocument {
  const indexed = config.index(doc);
  const store = config.store?.(doc) ?? {};
  const locale = doc._meta.locale ?? "default";
  const row: OramaIndexDocument = {
    // Orama requires unique `id` values across the whole database.
    id: `${collection}:${locale}:${doc._meta.id}`,
    collection,
    locale,
    documentId: doc._meta.id,
    store: JSON.stringify(store),
  };

  for (const [key, type] of Object.entries(unionSchema)) {
    if (BASE_KEYS.has(key)) continue;
    const value = readIndexedValue(indexed, key);
    row[key] = value === undefined ? emptyForType(type) : value;
  }

  return row;
}

/** Build and write the Orama search snapshot for an integration run. */
export async function buildOramaIndex(
  options: OramaIntegrationOptions,
  context: IntegrationRuntimeContext,
): Promise<string> {
  const directory = options.directory ?? "search";
  const filename = options.filename ?? "orama.json";
  if (!isCollectionConfigMap(options.collections)) {
    throw new Error("@anhur/orama: collections must be an object.");
  }
  const collectionConfigs = options.collections;

  const contentNames = new Set(
    context.config.content
      .filter((source) => source.type === "collection")
      .map((source) => source.name),
  );

  for (const name of Object.keys(collectionConfigs)) {
    if (!contentNames.has(name)) {
      throw new Error(
        `@anhur/orama: "${name}" is not a collection in defineConfig({ content }).`,
      );
    }
  }

  const unionSchema = mergeSchema(collectionConfigs);
  const searchProperties = searchPropertiesFor(unionSchema);

  const documents: OramaIndexDocument[] = [];
  const includedCollections: string[] = [];

  for (const [name, config] of Object.entries(collectionConfigs)) {
    const source = context.sources.find((s) => s.name === name);
    if (!source) {
      throw new Error(
        `@anhur/orama: collection "${name}" is not in defineConfig({ content }).`,
      );
    }
    if (source.type !== "collection") {
      throw new Error(
        `@anhur/orama: "${name}" must be a collection (singletons are not supported yet).`,
      );
    }
    includedCollections.push(name);
    for (const doc of source.documents) {
      documents.push(toOramaDoc(name, doc, config, unionSchema));
    }
  }

  const snapshot: AnhurOramaIndex = {
    version: 2,
    schema: unionSchema,
    searchProperties,
    collections: includedCollections,
    documents,
  };

  const outDir = path.join(context.outputDir, directory);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);
  await writeFile(outPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  return outPath;
}
