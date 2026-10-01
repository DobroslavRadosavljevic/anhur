/**
 * `@anhur/core` — define content: collections, singletons, views, schema
 * helpers, and the types generated modules use. The build engine lives in
 * `@anhur/core/build`; plugin authoring APIs in `@anhur/core/plugin`.
 */
export {
  defineCollection,
  defineSingleton,
  createSkippedSignal,
  isSkippedSignal,
  type DefineCollectionInput,
  type DefineSingletonInput,
  type DataFromTransformOut,
} from "./define/content";
export {
  defineView,
  defineIndex,
  defineGroup,
  createDerivedHelpers,
  type DefineView,
  type DefineIndex,
  type DefineGroup,
  type DerivedHelpers,
  type TypedViewContext,
  type ViewSourceDocument,
} from "./define/derived";
export { defineConfig } from "./define/config";
export { schema } from "./schema";
export type {
  ExcerptOptions,
  DocumentMetadata,
  SlugOptions,
  IsoDateOptions,
  ReferenceOptions,
} from "./schema/builtin-fields";
export type { TocEntry, TocOptions } from "./schema/toc";
export type {
  AnhurConfig,
  AnyCollection,
  AnyContent,
  AnyDerived,
  AnyGroup,
  AnyIndex,
  AnySingleton,
  AnyView,
  BuiltContentSnapshot,
  CollectionDefinition,
  CollectionGenerateOptions,
  CollectionOnSuccess,
  CompleteContext,
  CompleteHook,
  ContentSchema,
  DerivedGenerateOptions,
  DocumentTransform,
  FolderLocalization,
  GenerateSplit,
  GroupDefinition,
  GroupGenerateOptions,
  IndexDefinition,
  IndexGenerateOptions,
  ListSort,
  Localization,
  PrepareHook,
  SchemaDocument,
  SchemaOutput,
  SingletonDefinition,
  SingletonGenerateOptions,
  SingletonOnSuccess,
  SkippedSignal,
  TransformContext,
  TransformDocument,
  ViewContext,
  ViewDefinition,
  ViewGenerateOptions,
} from "./define/types";
export type {
  ConfigLocale,
  ContentMetaFor,
  DerivedName,
  DocumentForConfig,
  EmbeddedDocument,
  GetTypeByName,
  GetViewByName,
  InferDocument,
  InferSchemaData,
  InferViewData,
  TypedConfig,
  OmitListFields,
  RemapEmbeddedRefs,
  UnboundEmbed,
  AlignEmbeddedRefs,
  HideEmbeddedRefs,
} from "./define/infer";
export type {
  ContentMeta,
  DocumentFields,
  DocumentValue,
  DocumentWithMeta,
  FieldPath,
} from "./document";
export {
  AnhurBuildError,
  isAnhurBuildError,
  formatDiagnostic,
  formatDiagnostics,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
} from "./diagnostics";
export type {
  AnhurPlugin,
  ContentPlugin,
  Loader,
  PluginInput,
  UniqueOptions,
} from "./plugin/types";
