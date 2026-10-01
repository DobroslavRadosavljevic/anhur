import path from "node:path";
import { Predicate } from "effect";
import { resolvePluginInput } from "../plugin/define";
import type {
  AnhurConfig,
  AnyCollection,
  AnyContent,
  AnyDerived,
  AnySingleton,
  DocumentTransform,
  GenerateSplit,
  ListSort,
  Localization,
} from "../define/types";
import {
  errorDiagnostic,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import {
  arrayTypeName,
  camelCase,
  fileSafeName,
  isValidIdentifier,
  listExportName,
  pascalCase,
  plural,
} from "../naming";
import type {
  AnhurPlugin,
  AssetHost,
  BuildMode,
  Loader,
  ReferenceFieldSpec,
  UniqueOptions,
} from "../plugin/types";
import {
  analyzeSchema,
  formatPattern,
  type PatternSegment,
  type SchemaAnalysis,
} from "../schema/walk";
import { fingerprint } from "./fingerprint";
import { isInside, overlaps } from "./paths";

export type ResolvedCollectionGenerate = {
  readonly split: GenerateSplit;
  readonly listOmit: readonly string[];
  readonly lookupBy: readonly string[];
  readonly emitIds: boolean;
  readonly emitSlugs: boolean;
  readonly listSort: ListSort | undefined;
  /** Per-document modules + getter (`split: "light"`). */
  readonly emitDocuments: boolean;
};

export type ResolvedSingletonGenerate = {
  readonly split: GenerateSplit;
  readonly emitAll: boolean;
  readonly emitDocuments: boolean;
};

/** A reference field of a source schema. */
export type ReferenceLocation = {
  readonly pattern: readonly PatternSegment[];
  readonly spec: ReferenceFieldSpec;
};

/** A unique constraint of a source schema. */
export type UniqueLocation = {
  readonly pattern: readonly PatternSegment[];
  readonly options: UniqueOptions;
};

type SourceCommon = {
  readonly name: string;
  readonly localized: boolean;
  /** Absolute directory the source reads from. */
  readonly root: string;
  readonly analysis: SchemaAnalysis;
  readonly references: readonly ReferenceLocation[];
  readonly uniques: readonly UniqueLocation[];
  /** Folder under the output dir for per-document modules (POSIX). */
  readonly documentsDir: string;
};

export type ResolvedCollection = SourceCommon & {
  readonly kind: "collection";
  readonly definition: AnyCollection;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly names: {
    readonly typeName: string;
    readonly listName: string;
    readonly getterName: string;
    readonly arrayTypeName: string;
    readonly listItemTypeName: string;
    readonly idTypeName: string;
    readonly slugTypeName: string;
  };
  readonly generate: ResolvedCollectionGenerate;
};

export type ResolvedSingleton = SourceCommon & {
  readonly kind: "singleton";
  readonly definition: AnySingleton;
  /** Absolute file (monolingual singletons). */
  readonly filePath: string | undefined;
  readonly include: readonly string[];
  readonly names: {
    readonly typeName: string;
    readonly exportName: string;
    readonly getterName: string;
    readonly variantsName: string;
  };
  readonly generate: ResolvedSingletonGenerate;
};

export type ResolvedSource = ResolvedCollection | ResolvedSingleton;

export type ResolvedDerived = {
  readonly kind: "view" | "index" | "group";
  readonly definition: AnyDerived;
  readonly name: string;
  readonly from: readonly ResolvedCollection[];
  readonly usesSelect: boolean;
  readonly names: {
    /** List / record / groups export. */
    readonly exportName: string;
    readonly typeName: string;
    readonly listItemTypeName: string;
    readonly arrayTypeName: string;
    readonly recordTypeName: string;
    readonly keyTypeName: string;
    readonly groupTypeName: string;
  };
  readonly listOmit: readonly string[] | undefined;
  readonly listSort: ListSort | undefined;
  readonly limit: number | undefined;
};

export type ResolvedAssetHost = {
  readonly plugin: AnhurPlugin;
  readonly host: AssetHost;
  /** Absolute roots assets may be read from. */
  readonly roots: readonly string[];
};

/** Normalized, validated project: the only config shape the engine reads. */
export type ResolvedProject = {
  readonly config: AnhurConfig;
  readonly configPath: string;
  /** Directory of the config file; all relative paths resolve from here. */
  readonly projectDir: string;
  readonly outputDir: string;
  readonly cacheDir: string | undefined;
  readonly mode: BuildMode;
  readonly localization: Localization | undefined;
  readonly sources: readonly ResolvedSource[];
  readonly derived: readonly ResolvedDerived[];
  readonly plugins: readonly AnhurPlugin[];
  /** User loaders, then plugin loaders (built-ins are appended by the loader stage). */
  readonly loaders: readonly Loader[];
  readonly assetHost: ResolvedAssetHost | undefined;
  /** Source names in embed-resolution order (targets before referrers). */
  readonly embedOrder: readonly string[];
  /** Changes whenever anything that affects the output changes. */
  readonly fingerprint: string;
};

export type ResolveOptions = {
  readonly configPath: string;
  readonly mode: BuildMode;
  /** Hash of the config file and the local modules it imports. */
  readonly sourceFingerprint: string;
};

export type ResolveResult = {
  readonly project: ResolvedProject | undefined;
  readonly diagnostics: readonly Diagnostic[];
};

const LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,34}$/;
/** Source / view names: used in generated file names, comments and diagnostics. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function checkName(
  name: string,
  kind: string,
  diagnostics: Diagnostic[],
): boolean {
  if (NAME_PATTERN.test(name)) return true;
  diagnostics.push(
    errorDiagnostic(
      "naming-invalid",
      `${kind} name ${JSON.stringify(name)} must start with a letter and contain only letters, digits, "_" and "-" (at most 64 characters).`,
      { source: name },
    ),
  );
  return false;
}
const SPLITS = new Set<GenerateSplit>(["light", "full", "list-only"]);
const DEFAULT_LIST_OMIT = ["body"];
const DEFAULT_SINGLETON_INCLUDE = ["index.{md,mdx,yml,yaml,json}"];
const RESERVED_FILES = new Set([
  "index.js",
  "index.d.ts",
  "locales.js",
  ".anhur-manifest.json",
]);

function toList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return Predicate.isString(value) ? [value] : [...value];
}

function isStringList<T>(value: T): value is T & readonly string[] {
  return Array.isArray(value) && value.every(Predicate.isString);
}

function isNonEmptyString<T>(value: T): value is T & string {
  return Predicate.isString(value) && value.trim().length > 0;
}

function isZodSchema<T>(value: T): value is T & AnyContent["schema"] {
  return (
    Predicate.isObject(value) &&
    "_zod" in value &&
    "safeParseAsync" in value &&
    Predicate.isFunction(value.safeParseAsync)
  );
}

/** Collects exports / types / files and reports collisions. */
class SymbolTable {
  readonly #owners = new Map<string, string>();
  readonly #diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    this.#diagnostics = diagnostics;
  }

  add(
    space: "export" | "type" | "file",
    name: string,
    owner: string,
    hint: string,
  ): void {
    if (space !== "file" && !isValidIdentifier(name)) {
      this.#diagnostics.push(
        errorDiagnostic(
          "naming-invalid",
          `${owner} would generate the ${space} name "${name}", which is not a valid JavaScript identifier.`,
          { hint, source: owner },
        ),
      );
      return;
    }
    const key = `${space}:${space === "file" ? name.toLowerCase() : name}`;
    const existing = this.#owners.get(key);
    if (existing !== undefined) {
      this.#diagnostics.push(
        errorDiagnostic(
          "naming-collision",
          `${owner} and ${existing} both generate the ${space} "${name}".`,
          { hint, source: owner },
        ),
      );
      return;
    }
    this.#owners.set(key, owner);
  }
}

function checkListSort(
  value: ListSort | undefined,
  owner: string,
  diagnostics: Diagnostic[],
  rootKeys: readonly string[] | undefined,
): ListSort | undefined {
  if (value === undefined) return undefined;
  if (!Predicate.isObject(value) || !isNonEmptyString(value.by)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${owner}: listSort.by must be a field name.`,
      ),
    );
    return undefined;
  }
  if (
    value.order !== undefined &&
    value.order !== "asc" &&
    value.order !== "desc"
  ) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${owner}: listSort.order must be "asc" or "desc".`,
      ),
    );
  }
  if (rootKeys && rootKeys.length > 0 && !rootKeys.includes(value.by)) {
    diagnostics.push(
      warningDiagnostic(
        "config-invalid",
        `${owner}: listSort.by "${value.by}" is not a schema field; documents keep their order unless a transform adds it.`,
      ),
    );
  }
  return value;
}

function checkKeyList(
  value: readonly string[] | undefined,
  label: string,
  owner: string,
  diagnostics: Diagnostic[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isStringList(value)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${owner}: ${label} must be an array of field names.`,
      ),
    );
    return undefined;
  }
  return value;
}

/**
 * Static reference / unique locations, one entry per location and
 * settings: the same helper in several union variants (or both sides of an
 * intersection) is listed once. The build checks values per document with
 * `walkData`, which follows only the variant a document selects.
 */
function referencesOf(analysis: SchemaAnalysis): ReferenceLocation[] {
  const found = new Map<string, ReferenceLocation>();
  for (const field of analysis.fields) {
    if (field.spec.type !== "reference") continue;
    const { collection, by, embed } = field.spec;
    const key = JSON.stringify([field.pattern, collection, by, embed]);
    if (!found.has(key)) {
      found.set(key, { pattern: field.pattern, spec: field.spec });
    }
  }
  return [...found.values()];
}

function uniquesOf(analysis: SchemaAnalysis): UniqueLocation[] {
  const found = new Map<string, UniqueLocation>();
  for (const field of analysis.fields) {
    const options =
      field.spec.type === "unique"
        ? field.spec.options
        : field.spec.type === "compile"
          ? field.spec.unique
          : undefined;
    if (!options) continue;
    const key = JSON.stringify([field.pattern, options]);
    if (!found.has(key)) found.set(key, { pattern: field.pattern, options });
  }
  return [...found.values()];
}

/** Order sources so embed targets come before the sources that embed them. */
function embedOrder(
  sources: readonly ResolvedSource[],
  diagnostics: Diagnostic[],
): string[] {
  const edges = new Map<string, Set<string>>();
  for (const source of sources) {
    const targets = new Set<string>();
    for (const reference of source.references) {
      if (reference.spec.embed) targets.add(reference.spec.collection);
    }
    edges.set(source.name, targets);
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, trail: string[]): void => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(name)), name].join(" → ");
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `Embedded references form a cycle: ${cycle}.`,
          {
            source: name,
            hint: "Use s.reference(..., { embed: false }) on one side and look the document up with the getter, or join it in a transform.",
          },
        ),
      );
      return;
    }
    state.set(name, "visiting");
    for (const target of edges.get(name) ?? []) {
      if (edges.has(target)) visit(target, [...trail, name]);
    }
    state.set(name, "done");
    order.push(name);
  };
  for (const source of sources) visit(source.name, []);
  return order;
}

type ResolveContext = {
  readonly projectDir: string;
  readonly diagnostics: Diagnostic[];
  readonly symbols: SymbolTable;
  readonly localization: Localization | undefined;
  readonly pluginNames: ReadonlySet<string>;
};

function resolveLocalization(
  input: AnhurConfig["localization"],
  diagnostics: Diagnostic[],
): Localization | undefined {
  if (input === undefined) return undefined;
  if (!Predicate.isObject(input)) {
    diagnostics.push(
      errorDiagnostic("config-invalid", "localization must be an object."),
    );
    return undefined;
  }
  if (input.strategy !== "folder") {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        'localization.strategy must be "folder".',
      ),
    );
  }
  if (!isStringList(input.locales) || input.locales.length === 0) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        "localization.locales must be a non-empty array of strings.",
      ),
    );
    return undefined;
  }
  const seen = new Set<string>();
  for (const locale of input.locales) {
    if (!LOCALE_PATTERN.test(locale) || locale === "default") {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `Locale "${locale}" is not allowed.`,
          {
            hint: 'Use folder-safe codes like "en", "de-at", "pt_BR". "default" is reserved.',
          },
        ),
      );
    }
    if (seen.has(locale)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `Locale "${locale}" is listed twice.`,
        ),
      );
    }
    seen.add(locale);
  }
  if (!input.locales.includes(input.defaultLocale)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `localization.defaultLocale "${String(input.defaultLocale)}" must be one of the locales.`,
      ),
    );
  }
  return input;
}

function checkSchema(
  source: AnyContent,
  label: string,
  context: ResolveContext,
): SchemaAnalysis | undefined {
  if (!isZodSchema(source.schema)) {
    context.diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} needs a Zod schema (import { schema as s } from "@anhur/core").`,
        {
          source: source.name,
        },
      ),
    );
    return undefined;
  }
  const analysis = analyzeSchema(source.schema);
  for (const issue of analysis.issues) {
    context.diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} schema at "${formatPattern(issue.pattern) || "(root)"}": ${issue.message}`,
        {
          source: source.name,
        },
      ),
    );
  }
  for (const field of analysis.fields) {
    if (
      field.spec.type === "compile" &&
      field.spec.requires &&
      !context.pluginNames.has(field.spec.requires)
    ) {
      context.diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} field "${formatPattern(field.pattern)}" (${field.spec.kind}) needs the "${field.spec.requires}" plugin.`,
          {
            source: source.name,
            hint: `Add ${field.spec.requires}() to defineConfig({ plugins }).`,
          },
        ),
      );
    }
    if (
      field.spec.type === "unique" ||
      (field.spec.type === "compile" && field.spec.unique)
    ) {
      const options =
        field.spec.type === "unique" ? field.spec.options : field.spec.unique;
      if (
        options?.scope &&
        !["locale", "collection", "project"].includes(options.scope)
      ) {
        context.diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `${label} field "${formatPattern(field.pattern)}": unique scope must be "locale", "collection" or "project".`,
            {
              source: source.name,
            },
          ),
        );
      }
    }
  }
  return analysis;
}

function resolveCollection(
  source: AnyCollection,
  context: ResolveContext,
): ResolvedCollection | undefined {
  const label = `Collection "${source.name}"`;
  const diagnostics = context.diagnostics;
  let ok = true;
  if (!isNonEmptyString(source.directory)) {
    diagnostics.push(
      errorDiagnostic("config-invalid", `${label} needs a directory.`, {
        source: source.name,
      }),
    );
    ok = false;
  }
  const include = toList(source.include);
  if (include.length === 0 || !include.every(isNonEmptyString)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} needs include glob(s) such as "**/*.md".`,
        { source: source.name },
      ),
    );
    ok = false;
  }
  const exclude = toList(source.exclude);
  if (!exclude.every(isNonEmptyString)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} exclude must be glob strings.`,
        { source: source.name },
      ),
    );
  }
  if (source.localized === true && !context.localization) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} sets localized: true but the config has no localization.`,
        {
          source: source.name,
        },
      ),
    );
  }
  if (
    source.transform !== undefined &&
    !Predicate.isFunction(source.transform)
  ) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} transform must be a function.`,
        { source: source.name },
      ),
    );
  }
  const analysis = checkSchema(source, label, context);
  if (!ok || !analysis) return undefined;

  const gen = source.generate ?? {};
  const split = gen.split ?? "light";
  if (!SPLITS.has(split)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} generate.split must be "light", "full" or "list-only".`,
        {
          source: source.name,
        },
      ),
    );
  }
  const listOmit = checkKeyList(
    gen.listOmit,
    "generate.listOmit",
    label,
    diagnostics,
  );
  const lookupBy = checkKeyList(
    gen.lookupBy,
    "generate.lookupBy",
    label,
    diagnostics,
  );
  const rootKeys = analysis.rootKeys;
  for (const key of lookupBy ?? []) {
    if (key === "id") continue;
    if (rootKeys.length > 0 && !rootKeys.includes(key)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} generate.lookupBy "${key}" is not a schema field.`,
          {
            source: source.name,
          },
        ),
      );
    }
  }
  const listSort = checkListSort(gen.listSort, label, diagnostics, rootKeys);

  const typeName = source.typeName;
  const names = {
    typeName,
    listName: gen.listName ?? listExportName(source.name),
    getterName: gen.getterName ?? `get${typeName}`,
    arrayTypeName: gen.arrayTypeName ?? arrayTypeName(typeName),
    listItemTypeName: gen.listItemTypeName ?? `${typeName}ListItem`,
    idTypeName: `${typeName}Id`,
    slugTypeName: `${typeName}Slug`,
  };
  const emitDocuments = split === "light";
  const hint = `Set typeName / generate names on ${label}.`;
  context.symbols.add("type", names.typeName, label, hint);
  context.symbols.add("type", names.listItemTypeName, label, hint);
  if (names.arrayTypeName !== names.typeName) {
    context.symbols.add("type", names.arrayTypeName, label, hint);
  }
  context.symbols.add("export", names.listName, label, hint);
  context.symbols.add("file", `${names.listName}.js`, label, hint);
  if (emitDocuments) {
    context.symbols.add("export", names.getterName, label, hint);
    context.symbols.add("file", `${names.getterName}.js`, label, hint);
  }
  if (gen.emitIds) context.symbols.add("type", names.idTypeName, label, hint);
  if (gen.emitSlugs)
    context.symbols.add("type", names.slugTypeName, label, hint);
  const documentsDir = `documents/${fileSafeName(source.name)}`;
  context.symbols.add("file", documentsDir, label, hint);

  const localized = Boolean(context.localization) && source.localized !== false;
  return {
    kind: "collection",
    definition: source,
    name: source.name,
    localized,
    root: path.resolve(context.projectDir, source.directory),
    include,
    exclude,
    analysis,
    references: referencesOf(analysis),
    uniques: uniquesOf(analysis),
    documentsDir,
    names,
    generate: {
      split,
      listOmit: split === "full" ? [] : (listOmit ?? DEFAULT_LIST_OMIT),
      lookupBy:
        lookupBy ?? (analysis.commonRootKeys.includes("slug") ? ["slug"] : []),
      emitIds: gen.emitIds === true,
      emitSlugs: gen.emitSlugs === true,
      listSort,
      emitDocuments,
    },
  };
}

function resolveSingleton(
  source: AnySingleton,
  context: ResolveContext,
): ResolvedSingleton | undefined {
  const label = `Singleton "${source.name}"`;
  const diagnostics = context.diagnostics;
  const localized = Boolean(context.localization) && source.localized !== false;
  if (source.localized === true && !context.localization) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} sets localized: true but the config has no localization.`,
        {
          source: source.name,
        },
      ),
    );
  }
  let root: string | undefined;
  let filePath: string | undefined;
  if (localized) {
    if (!isNonEmptyString(source.directory)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} is localized and needs a directory with one folder per locale.`,
          {
            source: source.name,
            hint: "Set directory (and optionally include), or localized: false with filePath.",
          },
        ),
      );
    } else {
      root = path.resolve(context.projectDir, source.directory);
    }
    if (source.filePath !== undefined) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} is localized; filePath is ignored. Remove it or set localized: false.`,
          {
            source: source.name,
          },
        ),
      );
    }
  } else {
    if (!isNonEmptyString(source.filePath)) {
      diagnostics.push(
        errorDiagnostic("config-invalid", `${label} needs filePath.`, {
          source: source.name,
          hint: context.localization
            ? "Or remove localized: false and use directory."
            : undefined,
        }),
      );
    } else {
      filePath = path.resolve(context.projectDir, source.filePath);
      root = path.dirname(filePath);
    }
    if (source.directory !== undefined) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} is not localized; directory is ignored. Use filePath.`,
          {
            source: source.name,
          },
        ),
      );
    }
  }
  const include = toList(source.include);
  const analysis = checkSchema(source, label, context);
  if (!root || !analysis) return undefined;

  const gen = source.generate ?? {};
  const split = gen.split ?? "light";
  if (!SPLITS.has(split)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} generate.split must be "light", "full" or "list-only".`,
        {
          source: source.name,
        },
      ),
    );
  }
  const exportName = gen.exportName ?? camelCase(source.name);
  const names = {
    typeName: source.typeName,
    exportName,
    getterName: gen.getterName ?? `get${source.typeName}`,
    variantsName: gen.variantsName ?? `${exportName}All`,
  };
  const emitAll = localized && gen.emitAll !== false;
  const emitDocuments = split === "light";
  const hint = `Set typeName / generate names on ${label}.`;
  context.symbols.add("type", names.typeName, label, hint);
  context.symbols.add("export", names.exportName, label, hint);
  context.symbols.add("file", `${names.exportName}.js`, label, hint);
  if (emitAll) {
    context.symbols.add("export", names.variantsName, label, hint);
    context.symbols.add("file", `${names.variantsName}.js`, label, hint);
  }
  if (emitDocuments) {
    context.symbols.add("export", names.getterName, label, hint);
    context.symbols.add("file", `${names.getterName}.js`, label, hint);
  }
  const documentsDir = `documents/${fileSafeName(source.name)}`;
  context.symbols.add("file", documentsDir, label, hint);
  return {
    kind: "singleton",
    definition: source,
    name: source.name,
    localized,
    root,
    filePath,
    include: include.length > 0 ? include : DEFAULT_SINGLETON_INCLUDE,
    analysis,
    references: referencesOf(analysis),
    uniques: uniquesOf(analysis),
    documentsDir,
    names,
    generate: { split, emitAll, emitDocuments },
  };
}

function resolveDerived(
  entry: AnyDerived,
  collections: ReadonlyMap<string, ResolvedCollection>,
  context: ResolveContext,
): ResolvedDerived | undefined {
  const diagnostics = context.diagnostics;
  const kind = entry.type;
  const label = `${kind === "view" ? "View" : kind === "index" ? "Index" : "Group"} "${entry.name}"`;
  const fromList: readonly AnyCollection[] =
    kind === "view" ? entry.from : [entry.from];
  const from: ResolvedCollection[] = [];
  for (const source of fromList) {
    const resolved = Predicate.isObject(source)
      ? collections.get(source.name)
      : undefined;
    if (!resolved) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} reads from a collection that is not in defineConfig({ content }).`,
          {
            source: entry.name,
          },
        ),
      );
      return undefined;
    }
    if (from.includes(resolved)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} lists collection "${resolved.name}" twice.`,
          { source: entry.name },
        ),
      );
    }
    from.push(resolved);
  }
  if (from.length === 0) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} needs at least one collection in from.`,
        { source: entry.name },
      ),
    );
    return undefined;
  }
  if (kind === "view" && from.length > 1 && !entry.select) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} merges several collections and needs select() for a shared item shape.`,
        {
          source: entry.name,
        },
      ),
    );
  }
  for (const callback of ["where", "select"] as const) {
    const value = entry[callback];
    if (value !== undefined && !Predicate.isFunction(value)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} ${callback} must be a function.`,
          { source: entry.name },
        ),
      );
    }
  }
  if (kind !== "view") {
    const key = kind === "index" ? entry.key : entry.by;
    const keyLabel = kind === "index" ? "key" : "by";
    if (!Predicate.isFunction(key) && !isNonEmptyString(key)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `${label} ${keyLabel} must be a field name or a function.`,
          { source: entry.name },
        ),
      );
    } else if (Predicate.isString(key)) {
      const rootKeys = from[0]!.analysis.rootKeys;
      if (rootKeys.length > 0 && !rootKeys.includes(key)) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `${label} ${keyLabel} "${key}" is not a field of "${from[0]!.name}".`,
            {
              source: entry.name,
            },
          ),
        );
      }
    }
  }
  const gen = entry.generate ?? {};
  if (
    gen.limit !== undefined &&
    (!Number.isInteger(gen.limit) || gen.limit < 0)
  ) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} generate.limit must be a whole number ≥ 0.`,
        { source: entry.name },
      ),
    );
  }
  if (gen.compare !== undefined && !Predicate.isFunction(gen.compare)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        `${label} generate.compare must be a function.`,
        { source: entry.name },
      ),
    );
  }
  const listOmit = checkKeyList(
    gen.listOmit,
    "generate.listOmit",
    label,
    diagnostics,
  );
  const listSort = checkListSort(gen.listSort, label, diagnostics, undefined);

  const pascal = pascalCase(entry.name);
  const typeName = entry.typeName;
  const hint = `Set typeName / generate names on ${label}.`;
  let exportName: string;
  let listItemTypeName: string;
  let arrayName = "";
  let recordTypeName = "";
  let keyTypeName = "";
  let groupTypeName = "";
  if (kind === "view") {
    const viewGen = entry.generate ?? {};
    exportName = viewGen.listName ?? listExportName(entry.name);
    listItemTypeName = viewGen.listItemTypeName ?? typeName;
    arrayName = viewGen.arrayTypeName ?? plural(pascal);
    if (arrayName === listItemTypeName) arrayName = `${pascal}List`;
  } else if (kind === "index") {
    const indexGen = entry.generate ?? {};
    exportName =
      indexGen.exportName ??
      (isValidIdentifier(entry.name) ? entry.name : camelCase(entry.name));
    listItemTypeName = indexGen.listItemTypeName ?? typeName;
    recordTypeName = indexGen.recordTypeName ?? pascal;
    if (recordTypeName === listItemTypeName) recordTypeName = `${pascal}Map`;
    keyTypeName = `${pascal}Key`;
  } else {
    const groupGen = entry.generate ?? {};
    exportName =
      groupGen.exportName ??
      (isValidIdentifier(entry.name) ? entry.name : camelCase(entry.name));
    listItemTypeName = groupGen.listItemTypeName ?? typeName;
    groupTypeName = groupGen.groupTypeName ?? `${typeName}Group`;
    if (groupTypeName === listItemTypeName) groupTypeName = `${pascal}Group`;
    arrayName = groupGen.arrayTypeName ?? pascal;
    if (arrayName === listItemTypeName || arrayName === groupTypeName) {
      arrayName = `${pascal}List`;
    }
    keyTypeName = `${pascal}Key`;
  }
  context.symbols.add("export", exportName, label, hint);
  context.symbols.add("file", `${exportName}.js`, label, hint);
  context.symbols.add("type", listItemTypeName, label, hint);
  if (arrayName) context.symbols.add("type", arrayName, label, hint);
  if (recordTypeName) context.symbols.add("type", recordTypeName, label, hint);
  if (keyTypeName) context.symbols.add("type", keyTypeName, label, hint);
  if (groupTypeName) context.symbols.add("type", groupTypeName, label, hint);

  return {
    kind,
    definition: entry,
    name: entry.name,
    from,
    usesSelect: entry.select !== undefined,
    names: {
      exportName,
      typeName,
      listItemTypeName,
      arrayTypeName: arrayName,
      recordTypeName,
      keyTypeName,
      groupTypeName,
    },
    listOmit,
    listSort,
    limit: gen.limit,
  };
}

function checkReferences(
  sources: readonly ResolvedSource[],
  diagnostics: Diagnostic[],
): void {
  const byName = new Map(sources.map((source) => [source.name, source]));
  for (const source of sources) {
    for (const reference of source.references) {
      const target = byName.get(reference.spec.collection);
      const where = `${source.kind === "collection" ? "Collection" : "Singleton"} "${source.name}" field "${formatPattern(reference.pattern)}"`;
      if (!target) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `${where} references "${reference.spec.collection}", which is not in content.`,
            {
              source: source.name,
            },
          ),
        );
        continue;
      }
      const by = reference.spec.by;
      if (
        by !== "id" &&
        target.analysis.rootKeys.length > 0 &&
        !target.analysis.rootKeys.includes(by)
      ) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `${where} matches by "${by}", which is not a field of "${target.name}".`,
            {
              source: source.name,
            },
          ),
        );
      }
    }
  }
}

type ManagedPaths = {
  readonly projectDir: string;
  readonly outputDir: string;
  readonly cacheDir: string | undefined;
  readonly sources: readonly ResolvedSource[];
};

function checkPaths(project: ManagedPaths, diagnostics: Diagnostic[]): void {
  const { projectDir, outputDir, cacheDir } = project;
  const managed: [string, string][] = [["outputDir", outputDir]];
  if (cacheDir) managed.push(["cacheDir", cacheDir]);
  for (const [label, dir] of managed) {
    if (isInside(projectDir, dir)) {
      diagnostics.push(
        errorDiagnostic(
          "path-unsafe",
          `${label} "${dir}" is the project directory or one of its parents.`,
          {
            hint: `Use a dedicated folder such as ".anhur/${label === "outputDir" ? "generated" : "cache"}".`,
          },
        ),
      );
      continue;
    }
    for (const source of project.sources) {
      if (overlaps(dir, source.root) && !isInside(dir, source.root)) {
        diagnostics.push(
          errorDiagnostic(
            "path-unsafe",
            `${label} "${dir}" contains the content of "${source.name}".`,
            {
              source: source.name,
              hint: "Point it at a dedicated folder outside your content.",
            },
          ),
        );
      }
      if (
        source.kind === "singleton" &&
        source.filePath &&
        isInside(source.filePath, dir)
      ) {
        diagnostics.push(
          errorDiagnostic(
            "path-unsafe",
            `${label} "${dir}" contains the file of "${source.name}".`,
            { source: source.name },
          ),
        );
      }
    }
  }
  if (cacheDir && overlaps(cacheDir, outputDir)) {
    diagnostics.push(
      errorDiagnostic(
        "path-unsafe",
        "cacheDir and outputDir must be separate folders.",
      ),
    );
  }
}

type ResolvedPlugins = {
  readonly plugins: AnhurPlugin[];
  readonly assetHost: ResolvedAssetHost | undefined;
};

function resolvePlugins(
  config: AnhurConfig,
  projectDir: string,
  diagnostics: Diagnostic[],
): ResolvedPlugins {
  const plugins: AnhurPlugin[] = [];
  let assetHost: ResolvedAssetHost | undefined;
  const inputs = config.plugins ?? [];
  if (!Array.isArray(inputs)) {
    diagnostics.push(
      errorDiagnostic("config-invalid", "plugins must be an array."),
    );
    return { plugins, assetHost };
  }
  const names = new Set<string>();
  for (const input of inputs) {
    if (!Predicate.isObject(input) && !Predicate.isFunction(input)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          "Each plugins[] entry must be a plugin object or a plugin factory result.",
        ),
      );
      continue;
    }
    let plugin: AnhurPlugin;
    try {
      plugin = resolvePluginInput(input);
    } catch (cause) {
      diagnostics.push(
        errorDiagnostic(
          "plugin-failed",
          `A plugin factory threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          {
            cause,
          },
        ),
      );
      continue;
    }
    if (!Predicate.isObject(plugin) || !isNonEmptyString(plugin.name)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          "Each plugin needs a non-empty name.",
        ),
      );
      continue;
    }
    if (names.has(plugin.name)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `Plugin "${plugin.name}" is registered twice.`,
        ),
      );
      continue;
    }
    names.add(plugin.name);
    plugins.push(plugin);
    if (plugin.assets) {
      if (assetHost) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `Plugins "${assetHost.plugin.name}" and "${plugin.name}" both handle assets; register only one.`,
          ),
        );
        continue;
      }
      if (!isNonEmptyString(plugin.assets.base)) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `Plugin "${plugin.name}" needs an assets base URL.`,
          ),
        );
        continue;
      }
      const roots = [
        projectDir,
        ...(plugin.assets.roots ?? []).map((root) =>
          path.resolve(projectDir, root),
        ),
      ];
      assetHost = { plugin, host: plugin.assets, roots };
    }
  }
  return { plugins, assetHost };
}

function isContent<T>(value: T): value is T & AnyContent {
  return (
    Predicate.isObject(value) &&
    "type" in value &&
    (value.type === "collection" || value.type === "singleton") &&
    "name" in value &&
    isNonEmptyString(value.name)
  );
}

function isDerived<T>(value: T): value is T & AnyDerived {
  return (
    Predicate.isObject(value) &&
    "type" in value &&
    (value.type === "view" ||
      value.type === "index" ||
      value.type === "group") &&
    "name" in value &&
    isNonEmptyString(value.name)
  );
}

function isConfigObject<T>(value: T): value is T & AnhurConfig {
  return Predicate.isObject(value) && "content" in value;
}

/**
 * Validate a loaded config (whatever was default-exported) and normalize it.
 * Never throws; every problem becomes a diagnostic.
 */
export function resolveProject(
  input: unknown,
  options: ResolveOptions,
): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  const configPath = options.configPath;
  const projectDir = path.dirname(configPath);
  if (!isConfigObject(input) || !Array.isArray(input.content)) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        "The config must default-export defineConfig({ content: [...] }).",
        {
          file: configPath,
        },
      ),
    );
    return { project: undefined, diagnostics };
  }
  const config = input;
  if (config.content.length === 0) {
    diagnostics.push(
      errorDiagnostic(
        "config-invalid",
        "content needs at least one collection or singleton.",
        { file: configPath },
      ),
    );
  }
  const localization = resolveLocalization(config.localization, diagnostics);
  const { plugins, assetHost } = resolvePlugins(
    config,
    projectDir,
    diagnostics,
  );
  const symbols = new SymbolTable(diagnostics);
  for (const reserved of RESERVED_FILES)
    symbols.add("file", reserved, "Anhur", "This name is reserved.");
  if (localization) {
    symbols.add("export", "locales", "Anhur", "This name is reserved.");
    symbols.add("export", "defaultLocale", "Anhur", "This name is reserved.");
    symbols.add("type", "Locale", "Anhur", "This name is reserved.");
  }
  const context: ResolveContext = {
    projectDir,
    diagnostics,
    symbols,
    localization,
    pluginNames: new Set(plugins.map((plugin) => plugin.name)),
  };

  const sources: ResolvedSource[] = [];
  const seenNames = new Set<string>();
  config.content.forEach((entry, index) => {
    if (!isContent(entry)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `content[${index}] is not a collection or singleton. Create entries with defineCollection() / defineSingleton()${isDerived(entry) ? "; views belong in defineConfig({ views })" : ""}.`,
        ),
      );
      return;
    }
    if (
      !checkName(
        entry.name,
        entry.type === "collection" ? "Collection" : "Singleton",
        diagnostics,
      )
    )
      return;
    if (seenNames.has(entry.name)) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          `Two content sources are named "${entry.name}".`,
          { source: entry.name },
        ),
      );
      return;
    }
    seenNames.add(entry.name);
    const resolved =
      entry.type === "collection"
        ? resolveCollection(entry, context)
        : resolveSingleton(entry, context);
    if (resolved) sources.push(resolved);
  });

  const collections = new Map<string, ResolvedCollection>();
  for (const source of sources) {
    if (source.kind === "collection") collections.set(source.name, source);
  }
  const derived: ResolvedDerived[] = [];
  const views = config.views ?? [];
  if (!Array.isArray(views)) {
    diagnostics.push(
      errorDiagnostic("config-invalid", "views must be an array."),
    );
  } else {
    views.forEach((entry, index) => {
      if (!isDerived(entry)) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `views[${index}] is not a view, index or group. Create entries with defineView() / defineIndex() / defineGroup()${isContent(entry) ? "; collections belong in defineConfig({ content })" : ""}.`,
          ),
        );
        return;
      }
      if (!checkName(entry.name, "View", diagnostics)) return;
      if (seenNames.has(entry.name)) {
        diagnostics.push(
          errorDiagnostic(
            "config-invalid",
            `"${entry.name}" is used by more than one source or view.`,
            {
              source: entry.name,
            },
          ),
        );
        return;
      }
      seenNames.add(entry.name);
      const resolved = resolveDerived(entry, collections, context);
      if (resolved) derived.push(resolved);
    });
  }

  checkReferences(sources, diagnostics);
  const order = embedOrder(sources, diagnostics);

  const outputDir = path.resolve(
    projectDir,
    config.outputDir ?? ".anhur/generated",
  );
  const cacheDir =
    config.cacheDir === false
      ? undefined
      : path.resolve(projectDir, config.cacheDir ?? ".anhur/cache");
  if (config.outputDir !== undefined && !isNonEmptyString(config.outputDir)) {
    diagnostics.push(
      errorDiagnostic("config-invalid", "outputDir must be a non-empty path."),
    );
  }
  checkPaths({ projectDir, outputDir, cacheDir, sources }, diagnostics);

  const userLoaders = config.loaders ?? [];
  const loaders: Loader[] = [];
  for (const loader of [
    ...userLoaders,
    ...plugins.flatMap((plugin) => plugin.loaders ?? []),
  ]) {
    if (
      !Predicate.isObject(loader) ||
      !(loader.test instanceof RegExp) ||
      !Predicate.isFunction(loader.load)
    ) {
      diagnostics.push(
        errorDiagnostic(
          "config-invalid",
          "Each loader needs a test RegExp and a load function.",
        ),
      );
      continue;
    }
    loaders.push(loader);
  }

  for (const hook of ["prepare", "complete"] as const) {
    const value = config[hook];
    if (value !== undefined && !Predicate.isFunction(value)) {
      diagnostics.push(
        errorDiagnostic("config-invalid", `${hook} must be a function.`),
      );
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { project: undefined, diagnostics };
  }

  const project: ResolvedProject = {
    config,
    configPath,
    projectDir,
    outputDir,
    cacheDir,
    mode: options.mode,
    localization,
    sources,
    derived,
    plugins,
    loaders,
    assetHost,
    embedOrder: order,
    fingerprint: fingerprint([
      options.sourceFingerprint,
      configPath,
      options.mode,
      plugins.map((plugin) => [plugin.name, plugin.version ?? ""]),
    ]),
  };
  return { project, diagnostics };
}

/** Transform function of a source, if any. */
export function transformOf(
  source: ResolvedSource,
): DocumentTransform | undefined {
  return source.definition.transform;
}
