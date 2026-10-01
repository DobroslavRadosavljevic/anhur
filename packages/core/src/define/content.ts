import type { DocumentWithMeta } from "../document";
import { collectionTypeName, singletonTypeName } from "../naming";
import type { AlignEmbeddedRefs } from "./infer";
import type {
  CollectionDefinition,
  CollectionGenerateOptions,
  CollectionOnSuccess,
  ContentSchema,
  DocumentTransform,
  SchemaOutput,
  SingletonDefinition,
  SingletonGenerateOptions,
  SingletonOnSuccess,
  SkippedSignal,
  TransformContext,
} from "./types";
import { skippedKey } from "./types";

/** Transform result without skips and `_meta`, per union variant. */
type TransformData<TOut> =
  Exclude<Awaited<TOut>, SkippedSignal> extends infer TData
    ? TData extends unknown
      ? Omit<TData, "_meta">
      : never
    : never;

/**
 * Data type produced by a transform result (`_meta` is always re-attached).
 * Distributes over union results, so discriminated-union documents keep
 * their variant fields. With the schema output `TSchemaData`, strings at
 * `embed: true` reference locations are typed as embedded documents,
 * exactly where the relations pass embeds them.
 */
export type DataFromTransformOut<
  TOut,
  TSchemaData = TransformData<TOut>,
> = AlignEmbeddedRefs<TransformData<TOut>, TSchemaData>;

type TransformInput<TSchema extends ContentSchema, TOut> = (
  document: DocumentWithMeta<SchemaOutput<TSchema>>,
  context: TransformContext,
) => TOut | SkippedSignal | Promise<TOut | SkippedSignal>;

export type DefineCollectionInput<
  TName extends string,
  TSchema extends ContentSchema,
  TOut extends object,
> = {
  /** Source name; also the default for generated names (`allPosts`, `getPost`). */
  readonly name: TName;
  /** Document type name. Default: singular PascalCase of `name`. */
  readonly typeName?: string;
  /** Folder with the files, relative to the config file. */
  readonly directory: string;
  /** Glob(s) inside `directory` (or inside each locale folder). */
  readonly include: string | readonly string[];
  readonly exclude?: string | readonly string[];
  readonly schema: TSchema;
  /** `false` keeps this collection monolingual in a localized project. */
  readonly localized?: boolean;
  /**
   * Map each validated document. Return new data (`_meta` is kept as is),
   * or `ctx.skip()` to drop the document. References are still string ids
   * here; they are resolved after every transform ran.
   */
  readonly transform?: TransformInput<TSchema, TOut>;
  /** Called after the output is published, with the final documents. */
  readonly onSuccess?: CollectionOnSuccess;
  readonly generate?: CollectionGenerateOptions;
};

/**
 * Define a collection: many files in a folder, one document each.
 *
 * Checks (paths, names, plugins, references) run when the config is loaded,
 * so mistakes are reported together with file and field context.
 */
export function defineCollection<
  TName extends string,
  TSchema extends ContentSchema,
  TOut extends object = DocumentWithMeta<SchemaOutput<TSchema>>,
  const TLocalized extends boolean | undefined = undefined,
>(
  input: DefineCollectionInput<TName, TSchema, TOut> & {
    readonly localized?: TLocalized;
  },
): CollectionDefinition<
  TName,
  TSchema,
  DataFromTransformOut<TOut, SchemaOutput<TSchema>>
> &
  (undefined extends TLocalized
    ? unknown
    : { readonly localized: TLocalized }) {
  const definition = {
    type: "collection" as const,
    name: input.name,
    typeName: input.typeName ?? collectionTypeName(input.name),
    directory: input.directory,
    include: input.include,
    exclude: input.exclude,
    schema: input.schema,
    localized: input.localized,
    // SAFETY: the engine passes `{ ...data, _meta }` documents and checks the result is a plain object.
    transform: input.transform as DocumentTransform | undefined,
    onSuccess: input.onSuccess,
    generate: input.generate,
  };
  // SAFETY: the phantom `_data` and literal `localized` exist only in the type system.
  return definition as CollectionDefinition<
    TName,
    TSchema,
    DataFromTransformOut<TOut, SchemaOutput<TSchema>>
  > &
    (undefined extends TLocalized
      ? unknown
      : { readonly localized: TLocalized });
}

type SingletonLocation =
  | {
      /** Single file (monolingual singleton), relative to the config file. */
      readonly filePath: string;
      readonly directory?: undefined;
      readonly include?: undefined;
    }
  | {
      /** Folder with one sub-folder per locale (localized singleton). */
      readonly directory: string;
      /** File glob inside each locale folder. Default `index.{md,mdx,yml,yaml,json}`. */
      readonly include?: string | readonly string[];
      readonly filePath?: undefined;
    };

export type DefineSingletonInput<
  TName extends string,
  TSchema extends ContentSchema,
  TOut extends object,
> = {
  readonly name: TName;
  /** Type name. Default: PascalCase of `name`. */
  readonly typeName?: string;
  readonly schema: TSchema;
  readonly localized?: boolean;
  /** Allow the file (or the default-locale file) to be missing. */
  readonly optional?: boolean;
  readonly transform?: TransformInput<TSchema, TOut>;
  /** Called after publish with every locale variant. */
  readonly onSuccess?: SingletonOnSuccess;
  readonly generate?: SingletonGenerateOptions;
} & SingletonLocation;

/**
 * Define a singleton: one document (one per locale when localized).
 * Use `filePath` for a single file, `directory` for locale folders.
 */
export function defineSingleton<
  TName extends string,
  TSchema extends ContentSchema,
  TOut extends object = DocumentWithMeta<SchemaOutput<TSchema>>,
  const TLocalized extends boolean | undefined = undefined,
>(
  input: DefineSingletonInput<TName, TSchema, TOut> & {
    readonly localized?: TLocalized;
  },
): SingletonDefinition<
  TName,
  TSchema,
  DataFromTransformOut<TOut, SchemaOutput<TSchema>>
> &
  (undefined extends TLocalized
    ? unknown
    : { readonly localized: TLocalized }) {
  const definition = {
    type: "singleton" as const,
    name: input.name,
    typeName: input.typeName ?? singletonTypeName(input.name),
    schema: input.schema,
    localized: input.localized,
    filePath: input.filePath,
    directory: input.directory,
    include: input.include,
    optional: input.optional,
    // SAFETY: the engine passes `{ ...data, _meta }` documents and checks the result is a plain object.
    transform: input.transform as DocumentTransform | undefined,
    onSuccess: input.onSuccess,
    generate: input.generate,
  };
  // SAFETY: the phantom `_data` and literal `localized` exist only in the type system.
  return definition as SingletonDefinition<
    TName,
    TSchema,
    DataFromTransformOut<TOut, SchemaOutput<TSchema>>
  > &
    (undefined extends TLocalized
      ? unknown
      : { readonly localized: TLocalized });
}

/** Create the value returned by `ctx.skip()`. */
export function createSkippedSignal(reason?: string): SkippedSignal {
  return { [skippedKey]: true, reason };
}

/** True for a `ctx.skip()` result (works across duplicated module copies). */
export function isSkippedSignal(value: unknown): value is SkippedSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    skippedKey in value &&
    value[skippedKey] === true
  );
}
