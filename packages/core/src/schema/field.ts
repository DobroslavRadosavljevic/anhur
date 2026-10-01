import { Predicate } from "effect";
import { z } from "zod";
import type { DocumentValue } from "../document";
import type {
  CompileFieldSpec,
  FieldSpec,
  ReferenceFieldSpec,
  UniqueFieldSpec,
} from "../plugin/types";

/**
 * Key under which Anhur stores field specs in Zod metadata. Clones
 * (`.describe()`, `.refine()`, …) inherit metadata, so markers survive
 * user chaining.
 */
export const FIELD_META_KEY = "anhur";

/**
 * The spec is also stored on the schema instance under a global symbol.
 * Zod keeps its metadata registry on `globalThis` only since 4.1.13; with
 * older versions two copies of Zod (config loaded through another module
 * instance) have separate registries, and this marker still finds the spec.
 */
const FIELD_SPEC_SYMBOL = Symbol.for("anhur.field-spec");

/** Clone chains (`.describe().refine()…`) are short; this only stops a corrupt cycle. */
const MAX_PARENT_DEPTH = 256;

const FIELD_TYPES = new Set(["compile", "reference", "unique"]);

function isFieldSpec<T>(value: T): value is T & FieldSpec {
  return (
    Predicate.isObject(value) &&
    "type" in value &&
    Predicate.isString(value.type) &&
    FIELD_TYPES.has(value.type)
  );
}

function ownSpec(schema: z.core.$ZodType): FieldSpec | undefined {
  const value: unknown = Reflect.get(schema, FIELD_SPEC_SYMBOL);
  return isFieldSpec(value) ? value : undefined;
}

/** Field spec attached to this exact schema node (or the node it was cloned from), if any. */
export function readFieldSpec(schema: z.core.$ZodType): FieldSpec | undefined {
  const spec = z.globalRegistry.get(schema)?.[FIELD_META_KEY];
  if (isFieldSpec(spec)) return spec;
  let node: z.core.$ZodType | undefined = schema;
  for (let depth = 0; node && depth < MAX_PARENT_DEPTH; depth += 1) {
    const own = ownSpec(node);
    if (own) return own;
    node = node._zod.parent;
  }
  return undefined;
}

function attach<TSchema extends z.ZodType>(
  schema: TSchema,
  spec: FieldSpec,
): TSchema {
  const marked = schema.meta({ [FIELD_META_KEY]: spec });
  Object.defineProperty(marked, FIELD_SPEC_SYMBOL, {
    value: spec,
    enumerable: false,
    configurable: true,
  });
  return marked;
}

/**
 * Mark a schema as an engine-compiled field. The engine calls `compile` with
 * the raw file value (and an explicit {@link FieldContext}) before Zod runs;
 * `output` then validates the compiled value. User refinements and
 * transforms chained on the result see the compiled value.
 */
export function defineField<TSchema extends z.ZodType<DocumentValue>>(
  output: TSchema,
  spec: Omit<CompileFieldSpec, "type">,
): TSchema {
  return attach(output, { ...spec, type: "compile" });
}

/** Attach a reference marker (`s.reference()`). */
export function markReference<TSchema extends z.ZodType>(
  schema: TSchema,
  spec: Omit<ReferenceFieldSpec, "type">,
): TSchema {
  return attach(schema, { ...spec, type: "reference" });
}

/** Attach a unique marker (`s.unique()`). */
export function markUnique<TSchema extends z.ZodType>(
  schema: TSchema,
  options: UniqueFieldSpec["options"],
): TSchema {
  return attach(schema, { type: "unique", options });
}
