import { createHash } from "node:crypto";
import path from "node:path";
import { Predicate } from "effect";
import {
  errorDiagnostic,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import { isValidIdentifier, slugify } from "../naming";
import type { EmittedModule } from "../plugin/types";
import type { DerivedResult } from "./derive";
import { toExport, toListRow } from "./list-rows";
import { toPosix } from "./paths";
import type {
  ResolvedCollection,
  ResolvedDerived,
  ResolvedProject,
  ResolvedSingleton,
} from "./resolve";
import { GENERATED_HEADER, toJsLiteral } from "./serialize";
import { sortBy } from "./sort";
import type { FinalDocument, SourceDocuments } from "./types";

/** One file of the generated output (path relative to the output dir, POSIX). */
export type OutputFile = {
  readonly path: string;
  readonly contents: string;
};

export type PlanInput = {
  readonly project: ResolvedProject;
  readonly sources: readonly SourceDocuments<FinalDocument>[];
  readonly derived: readonly DerivedResult[];
  readonly modules: readonly (EmittedModule & { readonly plugin: string })[];
  readonly files: readonly (OutputFile & { readonly plugin: string })[];
};

export type OutputPlan = {
  readonly files: readonly OutputFile[];
  readonly diagnostics: readonly Diagnostic[];
};

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

  add(file: OutputFile, owner: string): void {
    const key = file.path.toLowerCase();
    if (owner !== ANHUR && RESERVED_FILES.has(key)) {
      this.diagnostics.push(
        errorDiagnostic(
          "naming-collision",
          `${owner} writes "${file.path}", which Anhur writes itself; choose another path.`,
        ),
      );
      return;
    }
    const existing = this.owners.get(key);
    if (existing !== undefined) {
      this.diagnostics.push(
        errorDiagnostic(
          "naming-collision",
          `${owner} writes "${file.path}", which ${existing === owner ? "it" : existing} already writes (paths are compared case-insensitively).`,
        ),
      );
      return;
    }
    this.owners.set(key, owner);
    this.files.set(key, file);
  }

  literal(
    value: unknown,
    owner: { source: string; file?: string },
  ): string | undefined {
    const result = toJsLiteral(value);
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
}

function planCollection(
  plan: PlanBuilder,
  project: ResolvedProject,
  source: ResolvedCollection,
  documents: readonly FinalDocument[],
): void {
  const { names, generate } = source;
  const label = `Collection "${source.name}"`;
  const rows = sortBy(
    documents.map((document) => ({
      row: toListRow(document, generate.listOmit),
      file: document.file.absPath,
    })),
    generate.listSort,
    (entry) => entry.row,
  );
  const listCode = plan.documentsLiteral(rows, source.name);
  if (listCode !== undefined) {
    plan.add(
      {
        path: `${names.listName}.js`,
        contents: moduleText(`export default ${listCode};`),
      },
      label,
    );
  }
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
  if (generate.emitIds) {
    dts.push(
      `export type ${names.idTypeName} = ${literalUnion(documents.map((document) => document.file.id))};`,
    );
  }
  if (generate.emitSlugs) {
    const slugs = documents
      .map((document) => document.data.slug)
      .filter((value): value is string => Predicate.isString(value));
    dts.push(`export type ${names.slugTypeName} = ${literalUnion(slugs)};`);
  }
  dts.push(
    `export declare const ${names.listName}: __AnhurArray<${names.listItemTypeName}>;`,
  );

  if (!generate.emitDocuments) return;

  const loaders = new Map<string, string>();
  const stringOwners = new Map<
    string,
    { readonly modulePath: string; readonly field: string }
  >();
  const moduleNames = new Map<string, string>();
  for (const document of documents) {
    const moduleName = documentModuleName(
      document.file.locale,
      document.file.id,
    );
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
    const code = plan.literal(toExport(document), {
      source: source.name,
      file: document.file.absPath,
    });
    if (code === undefined) continue;
    const modulePath = `${source.documentsDir}/${moduleName}.js`;
    plan.add(
      { path: modulePath, contents: moduleText(`export default ${code};`) },
      label,
    );
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
      if (Predicate.isString(value) && value.length > 0) register(field, value);
    }
  }

  const entries = [...loaders.entries()]
    .map(
      ([key, modulePath]) =>
        `  [${JSON.stringify(key)}, () => import(${JSON.stringify(`./${modulePath}`)})],`,
    )
    .join("\n");
  const lookupFields = generate.lookupBy.filter((field) => field !== "id");
  const localized = source.localized;
  const defaultLocale = project.localization?.defaultLocale ?? "";
  plan.add(
    {
      path: `${names.getterName}.js`,
      contents: moduleText(
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
    },
    label,
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
  const primaryCode = plan.literal(primary ? toExport(primary) : undefined, {
    source: source.name,
    file: primary?.file.absPath,
  });
  if (primaryCode !== undefined) {
    plan.add(
      {
        path: `${names.exportName}.js`,
        contents: moduleText(`export default ${primaryCode};`),
      },
      label,
    );
  }
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
  if (generate.emitAll) {
    const allCode = plan.documentsLiteral(
      documents.map((document) => ({
        row: toExport(document),
        file: document.file.absPath,
      })),
      source.name,
    );
    if (allCode !== undefined) {
      plan.add(
        {
          path: `${names.variantsName}.js`,
          contents: moduleText(`export default ${allCode};`),
        },
        label,
      );
    }
    plan.indexJs.push(
      `export { default as ${names.variantsName} } from "./${names.variantsName}.js";`,
    );
    dts.push(
      `export declare const ${names.variantsName}: __AnhurArray<${names.typeName}>;`,
    );
  }
  if (!generate.emitDocuments) return;
  const entries: string[] = [];
  for (const document of documents) {
    const code = plan.literal(toExport(document), {
      source: source.name,
      file: document.file.absPath,
    });
    if (code === undefined) continue;
    const modulePath = `${source.documentsDir}/${documentModuleName(document.file.locale, document.file.id)}.js`;
    plan.add(
      { path: modulePath, contents: moduleText(`export default ${code};`) },
      label,
    );
    entries.push(
      `  [${JSON.stringify(document.file.locale ?? "")}, () => import(${JSON.stringify(`./${modulePath}`)})],`,
    );
  }
  plan.add(
    {
      path: `${names.getterName}.js`,
      contents: moduleText(
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
    },
    label,
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
  let value: unknown;
  if (result.kind === "view") {
    value = result.items;
    dts.push(
      `export type ${names.arrayTypeName} = __AnhurArray<${names.listItemTypeName}>;`,
    );
    dts.push(
      `export declare const ${names.exportName}: ${names.arrayTypeName};`,
    );
  } else if (result.kind === "index") {
    value = Object.fromEntries(result.entries);
    dts.push(
      `export type ${names.keyTypeName} = ${literalUnion(result.entries.map(([key]) => key))};`,
    );
    dts.push(
      `export type ${names.recordTypeName} = { readonly [K in ${names.keyTypeName}]: ${names.listItemTypeName} };`,
    );
    dts.push(
      `export declare const ${names.exportName}: ${names.recordTypeName};`,
    );
  } else {
    value = result.groups;
    dts.push(
      `export type ${names.keyTypeName} = ${literalUnion(result.groups.map((group) => group.key))};`,
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
  const code = plan.literal(value, { source: derived.name });
  if (code !== undefined) {
    plan.add(
      {
        path: `${names.exportName}.js`,
        contents: moduleText(`export default ${code};`),
      },
      label,
    );
  }
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

/** Build every generated file in memory. Nothing is written here. */
export function planOutput(input: PlanInput): OutputPlan {
  const { project } = input;
  const plan = new PlanBuilder();
  const localization = project.localization;
  if (localization) {
    plan.add(
      {
        path: "locales.js",
        contents: moduleText(
          `export const locales = ${JSON.stringify(localization.locales)};\nexport const defaultLocale = ${JSON.stringify(localization.defaultLocale)};`,
        ),
      },
      ANHUR,
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
    plan.add({ path: module.path, contents: module.code }, owner);
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
    plan.add({ path: file.path, contents: file.contents }, owner);
  }

  plan.add(
    {
      path: "index.js",
      contents: `${GENERATED_HEADER}\n${plan.indexJs.join("\n")}\n`,
    },
    ANHUR,
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
  plan.add(
    {
      path: "index.d.ts",
      contents: `${[...header, ...plan.indexDts, "", "export {};"].join("\n")}\n`,
    },
    ANHUR,
  );
  return { files: [...plan.files.values()], diagnostics: plan.diagnostics };
}
