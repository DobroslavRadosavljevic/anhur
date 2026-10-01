import type { DocumentFields } from "../document";
import { collectionTypeName } from "../naming";
import type {
  EmbeddedDocument,
  HideEmbeddedRefs,
  InferDocument,
  RemapEmbeddedRefs,
  UnboundEmbed,
} from "./infer";
import type {
  AnyCollection,
  AnyContent,
  GroupDefinition,
  GroupGenerateOptions,
  IndexDefinition,
  IndexGenerateOptions,
  ViewContext,
  ViewDefinition,
  ViewGenerateOptions,
} from "./types";

type Content = readonly AnyContent[] | undefined;

/**
 * Document type seen by `where` / `select` / key callbacks. With a content
 * tuple (from {@link createDerivedHelpers}) `embed: true` references are the
 * target documents; without one they are opaque {@link UnboundEmbed}
 * values (the runtime value is a document, not the string id).
 */
export type ViewSourceDocument<
  TCollection extends AnyCollection,
  TContent extends Content,
> = [TContent] extends [readonly AnyContent[]]
  ? RemapEmbeddedRefs<InferDocument<TCollection>, TContent>
  : HideEmbeddedRefs<InferDocument<TCollection>>;

type MultiCollectionDocument<
  TCollections extends readonly AnyCollection[],
  TContent extends Content,
> = {
  [I in keyof TCollections]: TCollections[I] extends AnyCollection
    ? ViewSourceDocument<TCollections[I], TContent> & {
        collection: TCollections[I]["name"];
      }
    : never;
}[number];

/**
 * Top-level fields with string values (valid index / group keys). Embedded
 * references are documents at runtime, so they are never keys.
 */
type StringFieldKeys<T> = {
  [K in keyof Omit<T, "_meta">]-?: [
    Extract<T[K], EmbeddedDocument | UnboundEmbed>,
  ] extends [never]
    ? Exclude<T[K], undefined> extends string
      ? K
      : never
    : never;
}[keyof Omit<T, "_meta">] &
  string;

/** `ViewContext` whose `documents()` is typed for the bound content. */
export type TypedViewContext<TContent extends Content> = ViewContext & {
  readonly documents: <TSource extends AnyContent>(
    source: TSource,
  ) => [TContent] extends [readonly AnyContent[]]
    ? RemapEmbeddedRefs<InferDocument<TSource>, TContent>[]
    : HideEmbeddedRefs<InferDocument<TSource>>[];
};

/** `defineView` overloads (type-predicate `where` narrows `select` and the item type). */
export interface DefineView<TContent extends Content> {
  <
    TName extends string,
    TCollection extends AnyCollection,
    TNarrow extends ViewSourceDocument<TCollection, TContent>,
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly where: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => document is TNarrow;
    readonly select: (
      document: TNarrow,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: ViewGenerateOptions;
  }): ViewDefinition<TName, TItem>;
  <
    TName extends string,
    TCollection extends AnyCollection,
    TNarrow extends ViewSourceDocument<TCollection, TContent>,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly where: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => document is TNarrow;
    readonly generate?: ViewGenerateOptions;
  }): ViewDefinition<TName, TNarrow>;
  <
    TName extends string,
    TCollection extends AnyCollection,
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly where?: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    readonly select: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: ViewGenerateOptions;
  }): ViewDefinition<TName, TItem>;
  <TName extends string, TCollection extends AnyCollection>(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly where?: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    readonly generate?: ViewGenerateOptions;
  }): ViewDefinition<TName, ViewSourceDocument<TCollection, TContent>>;
  <
    TName extends string,
    TCollections extends readonly [AnyCollection, ...AnyCollection[]],
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollections;
    readonly where?: (
      document: MultiCollectionDocument<TCollections, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    /** Required when merging collections: the shared item shape. */
    readonly select: (
      document: MultiCollectionDocument<TCollections, TContent>,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: ViewGenerateOptions;
  }): ViewDefinition<TName, TItem>;
}

type IndexKey<TDocument> =
  | StringFieldKeys<TDocument>
  | ((document: TDocument) => string);

/** `defineIndex` overloads. */
export interface DefineIndex<TContent extends Content> {
  <
    TName extends string,
    TCollection extends AnyCollection,
    TNarrow extends ViewSourceDocument<TCollection, TContent>,
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly key:
      | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
      | ((document: TNarrow) => string);
    readonly where: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => document is TNarrow;
    readonly select: (
      document: TNarrow,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: IndexGenerateOptions;
  }): IndexDefinition<TName, TItem>;
  <
    TName extends string,
    TCollection extends AnyCollection,
    TNarrow extends ViewSourceDocument<TCollection, TContent>,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly key:
      | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
      | ((document: TNarrow) => string);
    readonly where: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => document is TNarrow;
    readonly generate?: IndexGenerateOptions;
  }): IndexDefinition<TName, TNarrow>;
  <
    TName extends string,
    TCollection extends AnyCollection,
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly key: IndexKey<ViewSourceDocument<TCollection, TContent>>;
    readonly where?: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    readonly select: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: IndexGenerateOptions;
  }): IndexDefinition<TName, TItem>;
  <TName extends string, TCollection extends AnyCollection>(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly key: IndexKey<ViewSourceDocument<TCollection, TContent>>;
    readonly where?: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    readonly generate?: IndexGenerateOptions;
  }): IndexDefinition<TName, ViewSourceDocument<TCollection, TContent>>;
}

/** `defineGroup` overloads. */
export interface DefineGroup<TContent extends Content> {
  <
    TName extends string,
    TCollection extends AnyCollection,
    TNarrow extends ViewSourceDocument<TCollection, TContent>,
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly by:
      | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
      | ((document: TNarrow) => string);
    readonly where: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => document is TNarrow;
    readonly select: (
      document: TNarrow,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: GroupGenerateOptions;
  }): GroupDefinition<TName, TItem>;
  <
    TName extends string,
    TCollection extends AnyCollection,
    TItem extends DocumentFields,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly by: IndexKey<ViewSourceDocument<TCollection, TContent>>;
    readonly where?: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    readonly select: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => TItem;
    readonly generate?: GroupGenerateOptions;
  }): GroupDefinition<TName, TItem>;
  <
    TName extends string,
    TCollection extends AnyCollection,
    TNarrow extends ViewSourceDocument<TCollection, TContent>,
  >(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly by:
      | StringFieldKeys<ViewSourceDocument<TCollection, TContent>>
      | ((document: TNarrow) => string);
    readonly where: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => document is TNarrow;
    readonly generate?: GroupGenerateOptions;
  }): GroupDefinition<TName, TNarrow>;
  <TName extends string, TCollection extends AnyCollection>(input: {
    readonly name: TName;
    readonly typeName?: string;
    readonly from: TCollection;
    readonly by: IndexKey<ViewSourceDocument<TCollection, TContent>>;
    readonly where?: (
      document: ViewSourceDocument<TCollection, TContent>,
      context: TypedViewContext<TContent>,
    ) => boolean;
    readonly generate?: GroupGenerateOptions;
  }): GroupDefinition<TName, ViewSourceDocument<TCollection, TContent>>;
}

type ViewInput = {
  readonly name: string;
  readonly typeName?: string;
  readonly from: AnyCollection | readonly AnyCollection[];
  readonly where?: ViewDefinition["where"];
  readonly select?: ViewDefinition["select"];
  readonly generate?: ViewGenerateOptions;
};

function defineViewImpl(input: ViewInput): ViewDefinition {
  const from: readonly AnyCollection[] = Array.isArray(input.from)
    ? input.from
    : [input.from];
  return {
    type: "view",
    name: input.name,
    typeName: input.typeName ?? collectionTypeName(input.name),
    from,
    where: input.where,
    select: input.select,
    generate: input.generate,
  };
}

type KeyedInput = {
  readonly name: string;
  readonly typeName?: string;
  readonly from: AnyCollection;
  readonly where?: IndexDefinition["where"];
  readonly select?: IndexDefinition["select"];
};

function defineIndexImpl(
  input: KeyedInput & {
    readonly key: IndexDefinition["key"];
    readonly generate?: IndexGenerateOptions;
  },
): IndexDefinition {
  return {
    type: "index",
    name: input.name,
    typeName: input.typeName ?? collectionTypeName(input.name),
    from: input.from,
    key: input.key,
    where: input.where,
    select: input.select,
    generate: input.generate,
  };
}

function defineGroupImpl(
  input: KeyedInput & {
    readonly by: GroupDefinition["by"];
    readonly generate?: GroupGenerateOptions;
  },
): GroupDefinition {
  return {
    type: "group",
    name: input.name,
    typeName: input.typeName ?? collectionTypeName(input.name),
    from: input.from,
    by: input.by,
    where: input.where,
    select: input.select,
    generate: input.generate,
  };
}

/** List derived from one or more collections (filter, merge, sort, limit). */
// SAFETY: the overload interface only refines callback parameter types; the runtime input matches ViewInput.
export const defineView = defineViewImpl as DefineView<undefined>;

/** `Record<key, item>` derived from one collection (detail routes, lookups). */
// SAFETY: the overload interface only refines callback parameter types; the runtime input matches KeyedInput.
export const defineIndex = defineIndexImpl as DefineIndex<undefined>;

/** `{ key, count, items }[]` groups derived from one collection (facets). */
// SAFETY: the overload interface only refines callback parameter types; the runtime input matches KeyedInput.
export const defineGroup = defineGroupImpl as DefineGroup<undefined>;

/** `defineView` / `defineIndex` / `defineGroup` typed for a content tuple. */
export type DerivedHelpers<TContent extends readonly AnyContent[]> = {
  readonly defineView: DefineView<TContent>;
  readonly defineIndex: DefineIndex<TContent>;
  readonly defineGroup: DefineGroup<TContent>;
};

/**
 * Bind the derived helpers to your content tuple so `embed: true`
 * references are typed as target documents inside callbacks. Pass the same
 * array you give `defineConfig({ content })`.
 *
 * @example
 * ```ts
 * const content = [authors, posts] as const;
 * const { defineView } = createDerivedHelpers(content);
 * defineView({
 *   name: "postsByAda",
 *   from: posts,
 *   where: (doc) => doc.author.name === "Ada",
 * });
 * ```
 */
export function createDerivedHelpers<
  const TContent extends readonly AnyContent[],
>(_content: TContent): DerivedHelpers<TContent> {
  return {
    // SAFETY: remapping is type-only; the runtime helpers are identical.
    defineView: defineViewImpl as DefineView<TContent>,
    // SAFETY: remapping is type-only; the runtime helpers are identical.
    defineIndex: defineIndexImpl as DefineIndex<TContent>,
    // SAFETY: remapping is type-only; the runtime helpers are identical.
    defineGroup: defineGroupImpl as DefineGroup<TContent>,
  };
}
