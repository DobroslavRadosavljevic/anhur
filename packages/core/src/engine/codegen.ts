import { createHash } from "node:crypto";
import path from "node:path";
import { Predicate } from "effect";
import {
  errorDiagnostic,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import type { DocumentValue } from "../document";
import { isValidIdentifier, slugify } from "../naming";
import type { EmittedModule } from "../plugin/types";
import type { DerivedResult } from "./derive";
import { toExport, toListRow } from "./list-rows";
import { toPosix } from "./paths";
import { sameItems } from "./same-items";
import type {
  ResolvedCollection,
  ResolvedDerived,
  ResolvedProject,
  ResolvedSingleton,
} from "./resolve";
import {
  GENERATED_HEADER,
  toJsLiteral,
  type SerializeOptions,
} from "./serialize";
import { sortBy } from "./sort";
import type { FinalDocument, SourceDocuments, SourceFile } from "./types";

/** One file of the generated output (path relative to the output dir, POSIX). */
export type OutputFile = {
  readonly path: string;
  /**
   * Text of the file. Called only when the file has to be written: an
   * unchanged file is recognized by `hash` and never built again.
   */
  readonly contents: () => string;
  /** {@link contentHash} of the text. */
  readonly hash: string;
  /** Length of the text in bytes (UTF-8). */
  readonly size: number;
};

/** A file a plugin emitted, as text. */
export type EmittedFile = {
  readonly path: string;
  readonly contents: string;
  readonly plugin: string;
};

export type PlanInput = {
  readonly project: ResolvedProject;
  readonly sources: readonly SourceDocuments<FinalDocument>[];
  readonly derived: readonly DerivedResult[];
  readonly modules: readonly (EmittedModule & { readonly plugin: string })[];
  readonly files: readonly EmittedFile[];
};

export type OutputPlan = {
  readonly files: readonly OutputFile[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Stands for the planned files: two plans made with the same memory have
   * the same revision exactly when they plan the same files with the same
   * text.
   */
  readonly revision: PlanRevision;
};

/** Identity of a plan (compared with `===`); a changed plan gets a new one. */
export type PlanRevision = { readonly kind: "plan-revision" };

function newRevision(): PlanRevision {
  return { kind: "plan-revision" };
}

/** Hash and size of a planned file, and what its text was built from. */
type FileRecord = {
  readonly inputs: readonly unknown[];
  readonly hash: string;
  readonly size: number;
};

/** A value computed for a plan, and what it was built from. */
type ValueRecord = {
  readonly inputs: readonly unknown[];
  readonly value: string;
};

/**
 * What a session remembers about generated files between builds. The text
 * of a file is a function of its inputs (documents, rows, emitted code); a
 * file whose inputs are the same objects as in the last build keeps its
 * hash without being built, hashed or written again.
 */
export type PlanMemory = {
  readonly files: Map<string, FileRecord>;
  readonly values: Map<string, ValueRecord>;
  readonly moduleNames: WeakMap<SourceFile, string>;
  /** {@link OutputPlan.revision} of the last plan. */
  revision: PlanRevision;
};

export function createPlanMemory(): PlanMemory {
  return {
    files: new Map(),
    values: new Map(),
    moduleNames: new WeakMap(),
    revision: newRevision(),
  };
}

/**
 * Hash stored in the output manifest for the text of a file (or for its
 * bytes on disk: the same value for UTF-8 text).
 */
export function contentHash(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 32);
}

/** Owner name of the files Anhur writes itself. */
const ANHUR = "Anhur";
/** Written by Anhur last; plugins may not use these paths. */
const RESERVED_FILES = new Set(["index.js", "index.d.ts"]);

/** Text that is safe inside a block comment. */
function commentText(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

function moduleText(body: string): string {
  return `${GENERATED_HEADER}\n${body}\n`;
}

function literalUnion(values: readonly string[]): string {
  const unique = [...new Set(values)].sort();
  return unique.length === 0
    ? "never"
    : unique.map((value) => JSON.stringify(value)).join(" | ");
}

function omitUnion(keys: readonly string[]): string {
  return keys.map((key) => JSON.stringify(key)).join(" | ");
}

/**
 * File-system and URL safe module name for a document:
 * `en/Guides/Intro` → `en-guides-intro-3f9c0a1b2d`.
 */
export function documentModuleName(
  locale: string | undefined,
  id: string,
): string {
  const readable = slugify(`${locale ?? ""} ${id}`).slice(0, 60) || "document";
  const hash = createHash("sha256")
    .update(`${locale ?? ""}\u0000${id}`)
    .digest("hex")
    .slice(0, 10);
  return `${readable}-${hash}`;
}

/** Import specifier of the config file from the output dir (`../../anhur.config.js`). */
function configImport(outputDir: string, configPath: string): string {
  let relative = toPosix(path.relative(outputDir, configPath));
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative
    .replace(/\.ts$/, ".js")
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs");
}

const SAFE_PLUGIN_PATH = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/;

class PlanBuilder {
  readonly files = new Map<string, OutputFile>();
  readonly diagnostics: Diagnostic[] = [];
  readonly indexJs: string[] = [];
  readonly indexDts: string[] = [];
  readonly exports = new Set<string>();

  private readonly owners = new Map<string, string>();
  /** Memory keys used by this plan; the others are dropped at the end. */
  private readonly usedFiles = new Set<string>();
  private readonly usedValues = new Set<string>();
  /** A file is new, has another text, or is gone: not the last plan. */
  private changed = false;

  constructor(readonly memory: PlanMemory) {}

  /**
   * Add a file whose text is `build()`. `inputs` stand for the text: when
   * they are the same objects as in the last build the text is not built
   * (and not hashed) again. `build` returns `undefined` when it reported a
   * diagnostic instead. Returns whether the file is part of the plan.
   */
  add(
    path: string,
    owner: string,
    inputs: readonly unknown[],
    build: () => string | undefined,
  ): boolean {
    const key = path.toLowerCase();
    if (owner !== ANHUR && RESERVED_FILES.has(key)) {
      this.diagnostics.push(
        errorDiagnostic(
          "naming-collision",
          `${owner} writes "${path}", which Anhur writes itself; choose another path.`,
        ),
      );
      return false;
    }
    const existing = this.owners.get(key);
    if (existing !== undefined) {
      this.diagnostics.push(
        errorDiagnostic(
          "naming-collision",
          `${owner} writes "${path}", which ${existing === owner ? "it" : existing} already writes (paths are compared case-insensitively).`,
        ),
      );
      return false;
    }
    this.owners.set(key, owner);
    this.usedFiles.add(path);
    const known = this.memory.files.get(path);
    if (known && sameItems(known.inputs, inputs)) {
      this.files.set(key, {
        path,
        hash: known.hash,
        size: known.size,
        contents: () => build() ?? "",
      });
      return true;
    }
    this.changed = true;
    const before = this.diagnostics.length;
    const text = build();
    if (text === undefined) return false;
    const hash = contentHash(text);
    const size = Buffer.byteLength(text);
    // A text built with diagnostics is built again next time, so they are reported again.
    if (this.diagnostics.length === before) {
      this.memory.files.set(path, { inputs: [...inputs], hash, size });
    }
    this.files.set(key, { path, hash, size, contents: () => text });
    return true;
  }

  /** Add a file with a fixed text. */
  addText(path: string, owner: string, text: string): void {
    this.add(path, owner, [text], () => text);
  }

  /** A string computed from `inputs`, kept while they are the same objects. */
  value(
    key: string,
    inputs: readonly unknown[],
    compute: () => string,
  ): string {
    this.usedValues.add(key);
    const known = this.memory.values.get(key);
    if (known && sameItems(known.inputs, inputs)) return known.value;
    const before = this.diagnostics.length;
    const value = compute();
    if (this.diagnostics.length === before) {
      this.memory.values.set(key, { inputs: [...inputs], value });
    }
    return value;
  }

  /**
   * Forget what the plan no longer uses (removed documents and sources)
   * and return the revision of this plan.
   */
  finish(): PlanRevision {
    for (const path of this.memory.files.keys()) {
      if (this.usedFiles.has(path)) continue;
      this.memory.files.delete(path);
      this.changed = true;
    }
    for (const key of this.memory.values.keys()) {
      if (!this.usedValues.has(key)) this.memory.values.delete(key);
    }
    if (this.changed) this.memory.revision = newRevision();
    return this.memory.revision;
  }

  literal(
    value: unknown,
    owner: { source: string; file?: string },
    options: SerializeOptions = {},
  ): string | undefined {
    const result = toJsLiteral(value, options);
    if (result.ok) return result.code;
    this.diagnostics.push(
      errorDiagnostic("serialize-failed", result.message, {
        source: owner.source,
        file: owner.file,
        fieldPath: result.fieldPath,
        hint: "Generated modules hold plain data (objects, arrays, strings, numbers, booleans, null, Date, Map, Set, BigInt).",
      }),
    );
    return undefined;
  }

  /** Serialize a list of documents, reporting the failing document. */
  documentsLiteral(
    rows: readonly { readonly row: unknown; readonly file: string }[],
    source: string,
  ): string | undefined {
    const parts: string[] = [];
    let ok = true;
    for (const entry of rows) {
      const code = this.literal(entry.row, { source, file: entry.file });
      if (code === undefined) ok = false;
      else parts.push(code);
    }
    return ok ? `[\n${parts.join(",\n")}\n]` : undefined;
  }

  /** Module name of a document, computed once per file. */
  moduleName(document: FinalDocument): string {
    let name = this.memory.moduleNames.get(document.file);
    if (name === undefined) {
      name = documentModuleName(document.file.locale, document.file.id);
      this.memory.moduleNames.set(document.file, name);
    }
    return name;
  }
}

/** `export default <code>;` module of a serialized value. */
function defaultModule(code: string | undefined): string | undefined {
  return code === undefined ? undefined : moduleText(`export default ${code};`);
}

function planCollection(
  plan: PlanBuilder,
  project: ResolvedProject,
  source: ResolvedCollection,
  documents: readonly FinalDocument[],
): void {
  const { names, generate } = source;
  const label = `Collection "${source.name}"`;
  const rows = documents.map((document) =>
    toListRow(document, generate.listOmit),
  );
  plan.add(`${names.listName}.js`, label, rows, () =>
    defaultModule(
      plan.documentsLiteral(
        sortBy(
          documents.map((document, index) => ({
            row: rows[index]!,
            file: document.file.absPath,
          })),
          generate.listSort,
          (entry) => entry.row,
        ),
        source.name,
      ),
    ),
  );
  plan.indexJs.push(
    `export { default as ${names.listName} } from "./${names.listName}.js";`,
  );

  const dts = plan.indexDts;
  dts.push(
    `export type ${names.typeName} = __AnhurGetTypeByName<typeof __AnhurConfig, ${JSON.stringify(source.name)}>;`,
  );
  dts.push(
    generate.listOmit.length === 0
      ? `export type ${names.listItemTypeName} = ${names.typeName};`
      : `export type ${names.listItemTypeName} = __AnhurOmitListFields<${names.typeName}, ${omitUnion(generate.listOmit)}>;`,
  );
  if (names.arrayTypeName !== names.typeName) {
    dts.push(
      `export type ${names.arrayTypeName} = __AnhurArray<${names.typeName}>;`,
    );
  }
  // Ids and slugs stay the same when a document is edited: these are
  // keyed by the files and values they come from, not by the documents.
  const files = documents.map((document) => document.file);
  if (generate.emitIds) {
    const ids = plan.value(`${source.name}\u0000ids`, files, () =>
      literalUnion(files.map((file) => file.id)),
    );
    dts.push(`export type ${names.idTypeName} = ${ids};`);
  }
  if (generate.emitSlugs) {
    const values = documents.map((document) => document.data.slug);
    const slugs = plan.value(`${source.name}\u0000slugs`, values, () =>
      literalUnion(
        values.filter((value): value is string => Predicate.isString(value)),
      ),
    );
    dts.push(`export type ${names.slugTypeName} = ${slugs};`);
  }
  dts.push(
    `export declare const ${names.listName}: __AnhurArray<${names.listItemTypeName}>;`,
  );

  if (!generate.emitDocuments) return;

  // Every build: one module per document (unchanged ones keep their hash).
  const modulePaths = new Map<FinalDocument, string>();
  const moduleNames = new Map<string, string>();
  for (const document of documents) {
    const moduleName = plan.moduleName(document);
    const taken = moduleNames.get(moduleName.toLowerCase());
    if (taken !== undefined) {
      plan.diagnostics.push(
        errorDiagnostic(
          "naming-collision",
          `${label}: documents "${taken}" and "${document.file.meta.filePath}" map to the same module name.`,
          {
            file: document.file.absPath,
            source: source.name,
            hint: "Rename one of the files.",
          },
        ),
      );
      continue;
    }
    moduleNames.set(moduleName.toLowerCase(), document.file.meta.filePath);
    const exported = toExport(document);
    const modulePath = `${source.documentsDir}/${moduleName}.js`;
    const added = plan.add(modulePath, label, [exported], () =>
      defaultModule(
        plan.literal(
          exported,
          { source: source.name, file: document.file.absPath },
          { remember: false },
        ),
      ),
    );
    if (added) modulePaths.set(document, modulePath);
  }

  // The lookup table of the getter: built again only when a file came or
  // went, or a lookup value changed.
  const lookups: unknown[] = [];
  for (const document of documents) {
    lookups.push(document.file, modulePaths.has(document));
    for (const field of generate.lookupBy) {
      if (field !== "id") lookups.push(document.data[field]);
    }
  }
  const entries = plan.value(`${source.name}\u0000loaders`, lookups, () => {
    const loaders = new Map<string, string>();
    const stringOwners = new Map<
      string,
      { readonly modulePath: string; readonly field: string }
    >();
    for (const document of documents) {
      const modulePath = modulePaths.get(document);
      if (modulePath === undefined) continue;
      const locale = document.file.locale ?? "";
      const register = (field: string, value: string) => {
        const key = `${locale}\u0000${field}\u0000${value}`;
        const previous = loaders.get(key);
        if (previous !== undefined && previous !== modulePath) {
          plan.diagnostics.push(
            errorDiagnostic(
              "naming-collision",
              `${label}: ${field} "${value}" matches more than one document${locale ? ` in "${locale}"` : ""}, so ${names.getterName}() cannot tell them apart.`,
              {
                file: document.file.absPath,
                source: source.name,
                hint: `Make "${field}" unique or remove it from generate.lookupBy.`,
              },
            ),
          );
          return;
        }
        loaders.set(key, modulePath);
        // A string query tries id first, then each lookup field.
        const byString = `${locale}\u0000${value}`;
        const first = stringOwners.get(byString);
        if (first === undefined) {
          stringOwners.set(byString, { modulePath, field });
        } else if (first.modulePath !== modulePath) {
          plan.diagnostics.push(
            warningDiagnostic(
              "naming-collision",
              `${label}: "${value}" is the ${first.field} of one document and the ${field} of another${locale ? ` in "${locale}"` : ""}; ${names.getterName}(${JSON.stringify(value)}) returns the first.`,
              {
                file: document.file.absPath,
                source: source.name,
                hint: `Query with an object to pick one: ${names.getterName}({ ${field}: ${JSON.stringify(value)} }).`,
              },
            ),
          );
        }
      };
      register("id", document.file.id);
      for (const field of generate.lookupBy) {
        if (field === "id") continue;
        const value = document.data[field];
        if (Predicate.isString(value) && value.length > 0) {
          register(field, value);
        }
      }
    }
    return [...loaders.entries()]
      .map(
        ([key, modulePath]) =>
          `  [${JSON.stringify(key)}, () => import(${JSON.stringify(`./${modulePath}`)})],`,
      )
      .join("\n");
  });
  const lookupFields = generate.lookupBy.filter((field) => field !== "id");
  const localized = source.localized;
  const defaultLocale = project.localization?.defaultLocale ?? "";
  plan.add(`${names.getterName}.js`, label, [entries], () =>
    moduleText(
      [
        `const loaders = new Map([\n${entries}\n]);`,
        `const lookupFields = ${JSON.stringify(lookupFields)};`,
        `const localized = ${localized ? "true" : "false"};`,
        `const defaultLocale = ${JSON.stringify(localized ? defaultLocale : "")};`,
        "",
        "function find(locale, field, value) {",
        '  if (typeof value !== "string" || value.length === 0) return undefined;',
        '  return loaders.get(locale + "\\u0000" + field + "\\u0000" + value);',
        "}",
        "",
        "/**",
        ` * Load one full ${commentText(source.name)} document (including fields left out of the list).`,
        ` * Pass an id${lookupFields.length > 0 ? ` or ${lookupFields.join(" / ")}` : ""}, or a query object. Returns null when nothing matches.`,
        " */",
        `export async function ${names.getterName}(query) {`,
        "  let locale = defaultLocale;",
        "  let loader;",
        '  if (typeof query === "string") {',
        '    loader = find(locale, "id", query);',
        "    for (const field of lookupFields) loader ??= find(locale, field, query);",
        '  } else if (query !== null && typeof query === "object") {',
        '    if (localized && typeof query.locale === "string") locale = query.locale;',
        '    if (query.id !== undefined) loader = find(locale, "id", query.id);',
        "    else {",
        "      for (const field of lookupFields) {",
        "        if (query[field] !== undefined) {",
        "          loader = find(locale, field, query[field]);",
        "          break;",
        "        }",
        "      }",
        "    }",
        "  }",
        "  if (!loader) return null;",
        "  return (await loader()).default;",
        "}",
      ].join("\n"),
    ),
  );
  plan.indexJs.push(
    `export { ${names.getterName} } from "./${names.getterName}.js";`,
  );
  const queryFields = [
    "id?: string",
    ...lookupFields.map((field) => `${JSON.stringify(field)}?: string`),
  ];
  if (localized && project.localization) {
    dts.push(
      `export declare function ${names.getterName}(query: { locale: Locale; ${queryFields.join("; ")} }): __AnhurPromise<${names.typeName} | null>;`,
    );
  } else {
    dts.push(
      `export declare function ${names.getterName}(idOrLookup: string): __AnhurPromise<${names.typeName} | null>;`,
    );
    dts.push(
      `export declare function ${names.getterName}(query: { ${queryFields.join("; ")} }): __AnhurPromise<${names.typeName} | null>;`,
    );
  }
}

function planSingleton(
  plan: PlanBuilder,
  project: ResolvedProject,
  source: ResolvedSingleton,
  documents: readonly FinalDocument[],
): void {
  const { names, generate } = source;
  const label = `Singleton "${source.name}"`;
  const defaultLocale = project.localization?.defaultLocale;
  const primary =
    documents.find((document) => document.file.locale === defaultLocale) ??
    (source.localized ? undefined : documents[0]);
  const primaryExport = primary ? toExport(primary) : undefined;
  plan.add(`${names.exportName}.js`, label, [primaryExport], () =>
    defaultModule(
      plan.literal(primaryExport, {
        source: source.name,
        file: primary?.file.absPath,
      }),
    ),
  );
  plan.indexJs.push(
    `export { default as ${names.exportName} } from "./${names.exportName}.js";`,
  );
  const dts = plan.indexDts;
  dts.push(
    `export type ${names.typeName} = __AnhurGetTypeByName<typeof __AnhurConfig, ${JSON.stringify(source.name)}>;`,
  );
  dts.push(
    `export declare const ${names.exportName}: ${names.typeName}${source.definition.optional ? " | undefined" : ""};`,
  );
  const exports = documents.map(toExport);
  if (generate.emitAll) {
    plan.add(`${names.variantsName}.js`, label, exports, () =>
      defaultModule(
        plan.documentsLiteral(
          documents.map((document, index) => ({
            row: exports[index]!,
            file: document.file.absPath,
          })),
          source.name,
        ),
      ),
    );
    plan.indexJs.push(
      `export { default as ${names.variantsName} } from "./${names.variantsName}.js";`,
    );
    dts.push(
      `export declare const ${names.variantsName}: __AnhurArray<${names.typeName}>;`,
    );
  }
  if (!generate.emitDocuments) return;
  const entries: string[] = [];
  for (const [index, document] of documents.entries()) {
    const exported = exports[index]!;
    const modulePath = `${source.documentsDir}/${plan.moduleName(document)}.js`;
    const added = plan.add(modulePath, label, [exported], () =>
      defaultModule(
        plan.literal(exported, {
          source: source.name,
          file: document.file.absPath,
        }),
      ),
    );
    if (!added) continue;
    entries.push(
      `  [${JSON.stringify(document.file.locale ?? "")}, () => import(${JSON.stringify(`./${modulePath}`)})],`,
    );
  }
  plan.addText(
    `${names.getterName}.js`,
    label,
    moduleText(
      [
        `const loaders = new Map([\n${entries.join("\n")}\n]);`,
        `const defaultLocale = ${JSON.stringify(source.localized ? (defaultLocale ?? "") : "")};`,
        "",
        `/** Load ${commentText(source.name)}${source.localized ? " for a locale (default locale when omitted)" : ""}. Returns null when missing. */`,
        `export async function ${names.getterName}(query) {`,
        `  const locale = ${source.localized ? 'query !== null && typeof query === "object" && typeof query.locale === "string" ? query.locale : defaultLocale' : "defaultLocale"};`,
        "  const loader = loaders.get(locale);",
        "  if (!loader) return null;",
        "  return (await loader()).default;",
        "}",
      ].join("\n"),
    ),
  );
  plan.indexJs.push(
    `export { ${names.getterName} } from "./${names.getterName}.js";`,
  );
  dts.push(
    source.localized && project.localization
      ? `export declare function ${names.getterName}(query?: { locale?: Locale }): __AnhurPromise<${names.typeName} | null>;`
      : `export declare function ${names.getterName}(): __AnhurPromise<${names.typeName} | null>;`,
  );
}

function derivedItemType(derived: ResolvedDerived): string {
  const base = `__AnhurGetViewByName<typeof __AnhurConfig, ${JSON.stringify(derived.name)}>`;
  if (derived.usesSelect) return base;
  const omit = derived.listOmit ?? derived.from[0]?.generate.listOmit ?? [];
  return omit.length === 0
    ? base
    : `__AnhurOmitListFields<${base}, ${omitUnion(omit)}>`;
}

function planDerived(plan: PlanBuilder, result: DerivedResult): void {
  const { derived } = result;
  const { names } = derived;
  const label = `${derived.kind} "${derived.name}"`;
  const dts = plan.indexDts;
  dts.push(
    `export type ${names.listItemTypeName} = ${derivedItemType(derived)};`,
  );
  // An unchanged view is the same result object as in the last build.
  const keys = (list: () => readonly string[]) =>
    plan.value(`${derived.name}\u0000keys`, [result], () =>
      literalUnion(list()),
    );
  let value: () => DocumentValue;
  if (result.kind === "view") {
    value = () => result.items;
    dts.push(
      `export type ${names.arrayTypeName} = __AnhurArray<${names.listItemTypeName}>;`,
    );
    dts.push(
      `export declare const ${names.exportName}: ${names.arrayTypeName};`,
    );
  } else if (result.kind === "index") {
    value = () => Object.fromEntries(result.entries);
    dts.push(
      `export type ${names.keyTypeName} = ${keys(() => result.entries.map(([key]) => key))};`,
    );
    dts.push(
      `export type ${names.recordTypeName} = { readonly [K in ${names.keyTypeName}]: ${names.listItemTypeName} };`,
    );
    dts.push(
      `export declare const ${names.exportName}: ${names.recordTypeName};`,
    );
  } else {
    value = () => result.groups;
    dts.push(
      `export type ${names.keyTypeName} = ${keys(() => result.groups.map((group) => group.key))};`,
    );
    dts.push(
      `export type ${names.groupTypeName} = { key: ${names.keyTypeName}; count: number; items: __AnhurArray<${names.listItemTypeName}> };`,
    );
    dts.push(
      `export type ${names.arrayTypeName} = __AnhurArray<${names.groupTypeName}>;`,
    );
    dts.push(
      `export declare const ${names.exportName}: ${names.arrayTypeName};`,
    );
  }
  plan.add(`${names.exportName}.js`, label, [result], () =>
    defaultModule(plan.literal(value(), { source: derived.name })),
  );
  plan.indexJs.push(
    `export { default as ${names.exportName} } from "./${names.exportName}.js";`,
  );
}

function isSafePluginPath(file: string): boolean {
  return (
    SAFE_PLUGIN_PATH.test(file) &&
    !file
      .split("/")
      .some(
        (segment) =>
          segment === ".." || segment === "." || segment.startsWith("."),
      )
  );
}

/**
 * Plan every generated file. Nothing is written here; the text of a file
 * is only built when it is new or its inputs changed since the last build
 * with the same `memory`.
 */
export function planOutput(
  input: PlanInput,
  memory: PlanMemory = createPlanMemory(),
): OutputPlan {
  const { project } = input;
  const plan = new PlanBuilder(memory);
  const localization = project.localization;
  if (localization) {
    plan.addText(
      "locales.js",
      ANHUR,
      moduleText(
        `export const locales = ${JSON.stringify(localization.locales)};\nexport const defaultLocale = ${JSON.stringify(localization.defaultLocale)};`,
      ),
    );
    plan.indexJs.push(`export { locales, defaultLocale } from "./locales.js";`);
    plan.indexDts.push(
      `export type Locale = ${literalUnion(localization.locales)};`,
    );
    plan.indexDts.push(
      `export declare const locales: readonly [${localization.locales.map((locale) => JSON.stringify(locale)).join(", ")}];`,
    );
    plan.indexDts.push(
      `export declare const defaultLocale: ${JSON.stringify(localization.defaultLocale)};`,
    );
  }

  for (const group of input.sources) {
    plan.indexDts.push("");
    if (group.source.kind === "collection") {
      planCollection(plan, project, group.source, group.documents);
    } else {
      planSingleton(plan, project, group.source, group.documents);
    }
  }
  for (const result of input.derived) {
    plan.indexDts.push("");
    planDerived(plan, result);
  }

  const takenExports = new Set(
    plan.indexJs.flatMap((line) => {
      const match = /^export \{ (.+) \} from/.exec(line);
      if (!match) return [];
      return match[1]!.split(",").map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      );
    }),
  );
  for (const module of input.modules) {
    const owner = `Plugin "${module.plugin}"`;
    if (!isSafePluginPath(module.path) || !module.path.endsWith(".js")) {
      plan.diagnostics.push(
        errorDiagnostic(
          "plugin-failed",
          `${owner} emitted the module path "${module.path}"; use a relative path like "search.js" (no "..", no dot-folders).`,
        ),
      );
      continue;
    }
    plan.addText(module.path, owner, module.code);
    const names = module.exports ?? [];
    const valid: string[] = [];
    for (const name of names) {
      if (!isValidIdentifier(name) || takenExports.has(name)) {
        plan.diagnostics.push(
          errorDiagnostic(
            "naming-collision",
            `${owner} exports "${name}", which is ${isValidIdentifier(name) ? "already exported by anhur/generated" : "not a valid identifier"}.`,
          ),
        );
        continue;
      }
      takenExports.add(name);
      valid.push(name);
    }
    if (valid.length > 0)
      plan.indexJs.push(
        `export { ${valid.join(", ")} } from "./${module.path}";`,
      );
    if (module.dts) {
      plan.indexDts.push("");
      plan.indexDts.push(module.dts.trim());
    }
  }
  for (const file of input.files) {
    const owner = `Plugin "${file.plugin}"`;
    if (!isSafePluginPath(file.path)) {
      plan.diagnostics.push(
        errorDiagnostic(
          "plugin-failed",
          `${owner} emitted the file path "${file.path}"; use a relative path without "..".`,
        ),
      );
      continue;
    }
    plan.addText(file.path, owner, file.contents);
  }

  plan.addText(
    "index.js",
    ANHUR,
    `${GENERATED_HEADER}\n${plan.indexJs.join("\n")}\n`,
  );
  const header = [
    GENERATED_HEADER,
    `import type { GetTypeByName as __AnhurGetTypeByName, GetViewByName as __AnhurGetViewByName, OmitListFields as __AnhurOmitListFields } from "@anhur/core";`,
    `import type __AnhurConfig from ${JSON.stringify(configImport(project.outputDir, project.configPath))};`,
    // Private aliases: user type names (a collection called "promises") must not shadow them.
    "type __AnhurPromise<T> = globalThis.Promise<T>;",
    "type __AnhurArray<T> = globalThis.Array<T>;",
    "",
  ];
  plan.addText(
    "index.d.ts",
    ANHUR,
    `${[...header, ...plan.indexDts, "", "export {};"].join("\n")}\n`,
  );
  const revision = plan.finish();
  return {
    files: [...plan.files.values()],
    diagnostics: plan.diagnostics,
    revision,
  };
}
