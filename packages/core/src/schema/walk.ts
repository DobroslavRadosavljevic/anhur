import { Predicate } from "effect";
import type { z } from "zod";
import {
  isPlainObject,
  readPath,
  setField,
  type DocumentFields,
  type DocumentValue,
  type FieldPath,
} from "../document";
import type { FieldSpec } from "../plugin/types";
import { readFieldSpec } from "./field";

type ZodNode = z.core.$ZodType;

/**
 * The parts of a Zod 4 schema definition the walker reads. Zod's own def
 * types are per-class; this view keeps the walker in one switch.
 */
type DefView = {
  readonly type: string;
  readonly innerType?: ZodNode;
  readonly element?: ZodNode;
  readonly items?: readonly ZodNode[];
  readonly rest?: ZodNode | null;
  readonly keyType?: ZodNode;
  readonly valueType?: ZodNode;
  readonly catchall?: ZodNode;
  readonly options?: readonly ZodNode[];
  readonly discriminator?: string;
  readonly left?: ZodNode;
  readonly right?: ZodNode;
  readonly in?: ZodNode;
  readonly out?: ZodNode;
  /** Set on codecs (`z.codec()`): the decode step between `in` and `out`. */
  readonly transform?: object;
  readonly getter?: () => ZodNode;
  readonly defaultValue?: DocumentValue;
};

/** Properties of an object schema (`z.object({...})`), in declaration order. */
function objectProperties(schema: ZodNode): [string, ZodNode][] {
  const def = schema._zod.def;
  if (!isObjectDef(def)) return [];
  return Object.entries(def.shape);
}

function isObjectDef(def: z.core.$ZodTypeDef): def is z.core.$ZodObjectDef {
  return def.type === "object";
}

function defOf(schema: ZodNode): DefView {
  // SAFETY: every Zod 4 schema exposes `_zod.def` with a string `type`; DefView only lists optional members read after switching on `type`.
  return schema._zod.def as DefView;
}

/**
 * One segment of a static field location: a key, any array item, or any
 * record value (`exclude` lists the declared keys of an object whose
 * `catchall` schema this is).
 */
export type PatternSegment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "item"; readonly index?: number }
  | { readonly kind: "record"; readonly exclude?: readonly string[] };

/** A field found by static analysis of a schema. */
export type FieldLocation = {
  readonly pattern: readonly PatternSegment[];
  readonly spec: FieldSpec;
};

/** Problems that make a schema unusable with field helpers. */
export type SchemaIssue = {
  readonly pattern: readonly PatternSegment[];
  readonly message: string;
};

export type SchemaAnalysis = {
  readonly fields: readonly FieldLocation[];
  readonly issues: readonly SchemaIssue[];
  /**
   * Every top-level key a document can have (all union variants, both
   * sides of an intersection). `[]` when the root shape is not known.
   */
  readonly rootKeys: readonly string[];
  /** Top-level keys every document has (keys shared by all union variants). */
  readonly commonRootKeys: readonly string[];
};

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "nonoptional",
  "readonly",
  "catch",
  "default",
  "prefault",
  "success",
]);

/** Nesting limit of the value walkers (schema steps, not only data levels). */
const MAX_WALK_DEPTH = 1000;

type SpecFilter = (spec: FieldSpec) => boolean;

const anySpec: SpecFilter = () => true;
const compileSpec: SpecFilter = (spec) => spec.type === "compile";

function containsFields(
  schema: ZodNode,
  seen: Set<ZodNode>,
  filter: SpecFilter = anySpec,
): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const spec = readFieldSpec(schema);
  if (spec) return filter(spec);
  return childSchemas(schema).some((child) =>
    containsFields(child, seen, filter),
  );
}

function childSchemas(schema: ZodNode): ZodNode[] {
  const def = defOf(schema);
  const children: ZodNode[] = [];
  if (def.innerType) children.push(def.innerType);
  for (const [, child] of objectProperties(schema)) children.push(child);
  if (def.catchall) children.push(def.catchall);
  if (def.element) children.push(def.element);
  if (def.items) children.push(...def.items);
  if (def.rest) children.push(def.rest);
  if (def.keyType) children.push(def.keyType);
  if (def.valueType) children.push(def.valueType);
  if (def.options) children.push(...def.options);
  if (def.left) children.push(def.left);
  if (def.right) children.push(def.right);
  if (def.in) children.push(def.in);
  if (def.out) children.push(def.out);
  if (def.type === "lazy" && def.getter) children.push(def.getter());
  return children;
}

/**
 * True when parsing `schema` can change the value it is given (a
 * transform, preprocess or codec step), so a later pipe stage sees a value
 * that is not the raw input.
 */
function transformsValue(schema: ZodNode, seen: Set<ZodNode>): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const def = defOf(schema);
  if (def.type === "transform") return true;
  if (def.type === "pipe") {
    if (def.transform !== undefined) return true;
    return (
      (def.in !== undefined && transformsValue(def.in, seen)) ||
      (def.out !== undefined && transformsValue(def.out, seen))
    );
  }
  if (def.type === "lazy" && def.getter) {
    return transformsValue(def.getter(), seen);
  }
  if (WRAPPERS.has(def.type) && def.innerType) {
    return transformsValue(def.innerType, seen);
  }
  return false;
}

/** The value that reaches `out` of this pipe is not the raw input. */
function pipeTransformsInput(def: DefView): boolean {
  return (
    def.transform !== undefined ||
    (def.in !== undefined && transformsValue(def.in, new Set()))
  );
}

type TopLevelKeys = {
  readonly all: readonly string[];
  readonly common: readonly string[];
};

function mergeKeySets(
  entries: readonly (TopLevelKeys | undefined)[],
  common: "union" | "intersection",
): TopLevelKeys | undefined {
  if (entries.length === 0) return undefined;
  const known: TopLevelKeys[] = [];
  for (const entry of entries) {
    if (!entry) return undefined;
    known.push(entry);
  }
  const all = [...new Set(known.flatMap((entry) => entry.all))];
  const shared =
    common === "union"
      ? [...new Set(known.flatMap((entry) => entry.common))]
      : known
          .slice(1)
          .reduce<readonly string[]>(
            (keys, entry) => keys.filter((key) => entry.common.includes(key)),
            known[0]!.common,
          );
  return { all, common: shared };
}

/** Top-level keys of the documents a schema produces, when they are known. */
function topLevelKeys(
  schema: ZodNode,
  seen: Set<ZodNode>,
): TopLevelKeys | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  try {
    const def = defOf(schema);
    if (def.type === "object") {
      const keys = objectProperties(schema).map(([key]) => key);
      return { all: keys, common: keys };
    }
    if (WRAPPERS.has(def.type) && def.innerType) {
      return topLevelKeys(def.innerType, seen);
    }
    if (def.type === "pipe") {
      const out = def.out ? topLevelKeys(def.out, seen) : undefined;
      if (out) return out;
      return def.in ? topLevelKeys(def.in, seen) : undefined;
    }
    if (def.type === "lazy" && def.getter) {
      return topLevelKeys(def.getter(), seen);
    }
    if (def.type === "union") {
      return mergeKeySets(
        (def.options ?? []).map((option) => topLevelKeys(option, seen)),
        "intersection",
      );
    }
    if (def.type === "intersection" && def.left && def.right) {
      return mergeKeySets(
        [topLevelKeys(def.left, seen), topLevelKeys(def.right, seen)],
        "union",
      );
    }
    return undefined;
  } finally {
    seen.delete(schema);
  }
}

/** Remembers which (spec, location) pairs were already reported. */
function createDedupe(): (spec: FieldSpec, location: string) => boolean {
  const seen = new Map<FieldSpec, Set<string>>();
  return (spec, location) => {
    let locations = seen.get(spec);
    if (!locations) {
      locations = new Set();
      seen.set(spec, locations);
    }
    if (locations.has(location)) return false;
    locations.add(location);
    return true;
  };
}

/**
 * Find every field helper in a schema without input. Array items and record
 * values appear as wildcard segments. Recursive (lazy) schemas are visited
 * once; the value walkers follow them to any depth. The same helper reached
 * twice at one location (union variants, intersections, pipes) is listed
 * once.
 */
export function analyzeSchema(schema: ZodNode): SchemaAnalysis {
  const fields: FieldLocation[] = [];
  const issues: SchemaIssue[] = [];
  const active = new Set<ZodNode>();
  const firstTime = createDedupe();

  const unsupported = (
    node: ZodNode,
    pattern: readonly PatternSegment[],
    message: string,
    filter: SpecFilter = anySpec,
  ): void => {
    if (containsFields(node, new Set(), filter)) {
      issues.push({ pattern: [...pattern], message });
    }
  };

  const visit = (node: ZodNode, pattern: PatternSegment[]): void => {
    const spec = readFieldSpec(node);
    if (spec) {
      if (firstTime(spec, JSON.stringify(pattern))) {
        fields.push({ pattern: [...pattern], spec });
      }
      return;
    }
    if (active.has(node)) return;
    active.add(node);
    const def = defOf(node);
    switch (def.type) {
      case "object": {
        const properties = objectProperties(node);
        for (const [key, child] of properties) {
          visit(child, [...pattern, { kind: "key", key }]);
        }
        if (def.catchall) {
          visit(def.catchall, [
            ...pattern,
            { kind: "record", exclude: properties.map(([key]) => key) },
          ]);
        }
        break;
      }
      case "array":
        if (def.element) visit(def.element, [...pattern, { kind: "item" }]);
        break;
      case "tuple":
        (def.items ?? []).forEach((item, index) => {
          visit(item, [...pattern, { kind: "item", index }]);
        });
        if (def.rest) visit(def.rest, [...pattern, { kind: "item" }]);
        break;
      case "record":
        if (def.keyType) {
          unsupported(
            def.keyType,
            pattern,
            "Anhur field helpers cannot be record keys. Use them for record values.",
          );
        }
        if (def.valueType) {
          visit(def.valueType, [...pattern, { kind: "record" }]);
        }
        break;
      case "map":
      case "set":
        unsupported(
          node,
          pattern,
          `Anhur field helpers inside z.${def.type}() are not supported. Use z.record() or z.array().`,
        );
        break;
      case "intersection":
        if (def.left) visit(def.left, pattern);
        if (def.right) visit(def.right, pattern);
        break;
      case "union": {
        const options = def.options ?? [];
        const withFields = options.filter((option) =>
          containsFields(option, new Set()),
        );
        if (withFields.length > 0 && !def.discriminator) {
          issues.push({
            pattern: [...pattern],
            message:
              "Anhur field helpers inside z.union() are not supported. Use z.discriminatedUnion() or move the helper out of the union.",
          });
        }
        for (const option of withFields) visit(option, pattern);
        break;
      }
      case "pipe":
        if (def.in) visit(def.in, pattern);
        if (def.out) {
          if (pipeTransformsInput(def)) {
            unsupported(
              def.out,
              pattern,
              "Anhur field helpers that compute a value (s.slug(), s.raw(), s.toc(), …) cannot follow a transform, z.preprocess() or z.codec(): they run on the raw file value before Zod. Put the helper before the transform.",
              compileSpec,
            );
          }
          visit(def.out, pattern);
        }
        break;
      case "lazy":
        if (def.getter) visit(def.getter(), pattern);
        break;
      default:
        if (WRAPPERS.has(def.type) && def.innerType) {
          visit(def.innerType, pattern);
        }
    }
    active.delete(node);
  };

  visit(schema, []);
  const keys = topLevelKeys(schema, new Set());
  return {
    fields,
    issues,
    rootKeys: keys?.all ?? [],
    commonRootKeys: keys?.common ?? [],
  };
}

function discriminatedOptions(
  def: DefView,
  value: DocumentValue,
): readonly ZodNode[] {
  const options = def.options ?? [];
  const key = def.discriminator;
  if (!key || !isPlainObject(value)) return [];
  const tag = Object.hasOwn(value, key) ? value[key] : undefined;
  return options.filter((option) => {
    const values = option._zod.propValues?.[key];
    if (!values) return false;
    return [...values].some((candidate) => candidate === tag);
  });
}

type WalkSide = "input" | "output";

type WalkHit = {
  readonly path: FieldPath;
  readonly pattern: readonly PatternSegment[];
  readonly spec: FieldSpec;
  readonly value: DocumentValue;
};

type WalkResult = {
  readonly hits: readonly WalkHit[];
  /** First path where the walk stopped because the value nests too deeply. */
  readonly tooDeep: FieldPath | undefined;
};

function ownValue(container: DocumentFields, key: string): DocumentValue {
  return Object.hasOwn(container, key) ? container[key] : undefined;
}

function isPresent(value: DocumentValue): boolean {
  return value !== undefined && value !== null;
}

/**
 * Walk a schema alongside a concrete value and collect every field helper.
 * Discriminated unions follow the variant the value selects; recursive
 * schemas are followed as deep as the value goes.
 *
 * - `input`: raw file data before Zod. Pipes continue into `out` only when
 *   nothing transforms the value first. A missing container with
 *   `.default()` / `.prefault()` is filled in (a copy of the default) when
 *   a compiled field inside it needs a place to be written.
 * - `output`: schema-validated data. Both pipe stages are followed.
 */
function walkValues(
  schema: ZodNode,
  root: DocumentValue,
  side: WalkSide,
): WalkResult {
  const hits: WalkHit[] = [];
  const firstTime = createDedupe();
  const active = new Map<ZodNode, Set<object>>();
  let tooDeep: FieldPath | undefined;
  const rootObject = isPlainObject(root) ? root : undefined;

  const materialize = (
    inner: ZodNode,
    defaultValue: DocumentValue,
    path: (string | number)[],
    pattern: PatternSegment[],
    depth: number,
  ): boolean => {
    const key = path[path.length - 1];
    if (!rootObject || !Predicate.isString(key)) return false;
    const parent = readPath(rootObject, path.slice(0, -1));
    if (!isPlainObject(parent) || isPresent(ownValue(parent, key))) {
      return false;
    }
    let copy: DocumentValue;
    try {
      copy = structuredClone(defaultValue);
    } catch {
      return false;
    }
    const hadKey = Object.hasOwn(parent, key);
    setField(parent, key, copy);
    const before = hits.length;
    visit(inner, copy, path, pattern, depth + 1);
    const needed = hits
      .slice(before)
      .some(
        (hit) =>
          hit.spec.type === "compile" &&
          (isPresent(hit.value) || hit.spec.whenAbsent === "compile"),
      );
    if (!needed) {
      if (hadKey) setField(parent, key, undefined);
      else Reflect.deleteProperty(parent, key);
    }
    return true;
  };

  const step = (
    node: ZodNode,
    value: DocumentValue,
    path: (string | number)[],
    pattern: PatternSegment[],
    depth: number,
  ): void => {
    const def = defOf(node);
    switch (def.type) {
      case "object": {
        if (!isPlainObject(value)) return;
        const properties = objectProperties(node);
        for (const [key, child] of properties) {
          visit(
            child,
            ownValue(value, key),
            [...path, key],
            [...pattern, { kind: "key", key }],
            depth + 1,
          );
        }
        if (def.catchall) {
          const declared = properties.map(([key]) => key);
          for (const key of Object.keys(value)) {
            if (declared.includes(key)) continue;
            visit(
              def.catchall,
              value[key],
              [...path, key],
              [...pattern, { kind: "record", exclude: declared }],
              depth + 1,
            );
          }
        }
        return;
      }
      case "array": {
        const element = def.element;
        if (!Array.isArray(value) || !element) return;
        const items: readonly DocumentValue[] = value;
        items.forEach((item, index) => {
          visit(
            element,
            item,
            [...path, index],
            [...pattern, { kind: "item" }],
            depth + 1,
          );
        });
        return;
      }
      case "tuple": {
        if (!Array.isArray(value)) return;
        const items: readonly DocumentValue[] = value;
        items.forEach((item, index) => {
          const declared = def.items?.[index];
          const itemSchema = declared ?? def.rest ?? undefined;
          if (!itemSchema) return;
          visit(
            itemSchema,
            item,
            [...path, index],
            [...pattern, declared ? { kind: "item", index } : { kind: "item" }],
            depth + 1,
          );
        });
        return;
      }
      case "record":
        if (!isPlainObject(value) || !def.valueType) return;
        for (const [key, item] of Object.entries(value)) {
          visit(
            def.valueType,
            item,
            [...path, key],
            [...pattern, { kind: "record" }],
            depth + 1,
          );
        }
        return;
      case "intersection":
        if (def.left) visit(def.left, value, path, pattern, depth + 1);
        if (def.right) visit(def.right, value, path, pattern, depth + 1);
        return;
      case "union":
        for (const option of discriminatedOptions(def, value)) {
          visit(option, value, path, pattern, depth + 1);
        }
        return;
      case "pipe":
        if (def.in) visit(def.in, value, path, pattern, depth + 1);
        if (def.out && (side === "output" || !pipeTransformsInput(def))) {
          visit(def.out, value, path, pattern, depth + 1);
        }
        return;
      case "lazy":
        if (def.getter) visit(def.getter(), value, path, pattern, depth + 1);
        return;
      case "default":
      case "prefault": {
        const inner = def.innerType;
        if (!inner) return;
        if (
          side === "input" &&
          value === undefined &&
          def.defaultValue !== undefined
        ) {
          const defaultValue = def.defaultValue;
          if (materialize(inner, defaultValue, path, pattern, depth)) return;
          visit(inner, defaultValue, path, pattern, depth + 1);
          return;
        }
        visit(inner, value, path, pattern, depth + 1);
        return;
      }
      default:
        if (WRAPPERS.has(def.type) && def.innerType) {
          visit(def.innerType, value, path, pattern, depth + 1);
        }
    }
  };

  const visit = (
    node: ZodNode,
    value: DocumentValue,
    path: (string | number)[],
    pattern: PatternSegment[],
    depth: number,
  ): void => {
    if (depth > MAX_WALK_DEPTH) {
      tooDeep ??= [...path];
      return;
    }
    const spec = readFieldSpec(node);
    if (spec) {
      if (firstTime(spec, JSON.stringify(path))) {
        hits.push({ path: [...path], pattern: [...pattern], spec, value });
      }
      return;
    }
    if (!Predicate.isObjectOrArray(value)) {
      step(node, value, path, pattern, depth);
      return;
    }
    let values = active.get(node);
    if (!values) {
      values = new Set();
      active.set(node, values);
    }
    // A value already being walked with this schema node is a data cycle.
    if (values.has(value)) return;
    values.add(value);
    try {
      step(node, value, path, pattern, depth);
    } finally {
      values.delete(value);
    }
  };

  visit(schema, root, [], [], 0);
  return { hits, tooDeep };
}

/** A field found while walking concrete file input. */
export type FieldOccurrence = {
  readonly path: FieldPath;
  readonly spec: FieldSpec;
  /** Raw value at `path` (or the schema default). */
  readonly value: DocumentValue;
  /** A value is present (not `undefined` / `null`). */
  readonly present: boolean;
};

/**
 * Walk a schema alongside raw file input (input side: pipes descend into
 * `out` only when no transform runs first, defaults fill missing values)
 * and return every field helper found. Containers missing from the input
 * are not entered, except a `.default()` / `.prefault()` container, which
 * is written into `input` when a compiled field inside it needs a place.
 */
export function walkInput(
  schema: ZodNode,
  input: DocumentValue,
): FieldOccurrence[] {
  return walkValues(schema, input, "input").hits.map((hit) => ({
    path: hit.path,
    spec: hit.spec,
    value: hit.value,
    present: isPresent(hit.value),
  }));
}

/** A field found in schema-validated (or transformed) document data. */
export type DataOccurrence = {
  readonly path: FieldPath;
  /** Static location (`tags[].ref`): the same for every array item / record key. */
  readonly field: string;
  readonly spec: FieldSpec;
  readonly value: DocumentValue;
};

export type DataWalk = {
  readonly occurrences: readonly DataOccurrence[];
  /** Set when the data nests deeper than the walker follows. */
  readonly tooDeep: FieldPath | undefined;
};

/**
 * Walk a schema alongside document data (output side) and return every
 * field helper with its concrete path. Only the union variant selected by
 * the data is followed, and recursive schemas are followed to any depth.
 */
export function walkData(schema: ZodNode, data: DocumentValue): DataWalk {
  const result = walkValues(schema, data, "output");
  return {
    occurrences: result.hits.map((hit) => ({
      path: hit.path,
      field: formatPattern(hit.pattern),
      spec: hit.spec,
      value: hit.value,
    })),
    tooDeep: result.tooDeep,
  };
}

/** `author`, `tags[]`, `links{}` — for diagnostics and unique groups. */
export function formatPattern(pattern: readonly PatternSegment[]): string {
  let out = "";
  for (const segment of pattern) {
    if (segment.kind === "key") {
      out += out.length === 0 ? segment.key : `.${segment.key}`;
    } else if (segment.kind === "item") {
      out += segment.index === undefined ? "[]" : `[${segment.index}]`;
    } else {
      out += "{}";
    }
  }
  return out;
}
