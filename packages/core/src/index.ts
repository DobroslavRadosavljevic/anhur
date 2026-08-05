export {
  collectionConstName,
  singletonConstName,
  generateTypeName,
  generateDocumentTypeName,
  generateCollectionArrayTypeName,
  singularizePascal,
  isCollection,
  isSingleton,
  isLocalized,
  resolveLocalization,
  defineCollection,
  defineSingleton,
  defineConfig,
  type ContentMeta,
  type Localization,
  type FolderLocalization,
  type ContentSchema,
  type GenerateSplit,
  type ListSort,
  type CollectionGenerateOptions,
  type SingletonGenerateOptions,
  type CollectionDefinition,
  type SingletonDefinition,
  type AnyCollection,
  type AnySingleton,
  type AnyContent,
  type AnhurConfig,
  type DocumentWithMeta,
  type TransformDocument,
  type DocumentTransform,
  type TransformContext,
  type InferSchemaData,
  type InferDocument,
  type GetTypeByName,
  type DefineCollectionInput,
  type DefineSingletonInput,
} from "./config";

export {
  DEFAULT_LIST_OMIT,
  DEFAULT_LOOKUP_BY,
  collectionGetterName,
  documentLookupKey,
  documentModuleBasename,
  omitKeysUnionType,
  resolveListOmit,
  resolveCollectionGenerate,
  resolveSingletonGenerate,
  sortByListSort,
  literalUnionType,
  getterQueryTypeFields,
  pickLookupKeyPart,
  collectStringFieldValues,
  collectDocumentIds,
  toDocumentExport,
  toListExport,
  type ResolvedCollectionGenerate,
  type ResolvedSingletonGenerate,
} from "./codegen";

export {
  defineProcessor,
  findProcessor,
  type ProcessorPlugin,
} from "./processors";

export {
  ASSETS_PROCESSOR_ID,
  createBuildContext,
  getBuildContext,
  resolveAssetsConfig,
  withBuildContext,
  type AssetsProcessorOptions,
  type BuildContext,
  type CreateBuildContextOptions,
  type EmittedAsset,
  type ResolvedAssetsConfig,
} from "./build-context";

export {
  getDocumentMeta,
  withDocumentMeta,
  type DocumentMeta,
} from "./document-meta";

export {
  schema,
  type UniqueOptions,
  type SlugOptions,
  type ReferenceOptions,
  type ExcerptOptions,
  type DocumentMetadata,
  type TocEntry,
  type TocOptions,
  type InferZod,
  type ZodType,
  type ZodTypeAny,
} from "./schema";

export {
  createTransformContext,
  toTransformDocument,
  toBuiltSnapshots,
  type TransformableSource,
  type BuiltContentSnapshot,
  type PrepareHook,
  type CompleteHook,
  type CollectionOnSuccess,
  type SingletonOnSuccess,
} from "./transform";

export {
  createSkippedSignal,
  isSkippedSignal,
  skippedSymbol,
  type SkippedSignal,
} from "./skip";

export { createPersistCache, type PersistCache } from "./persist-cache";

export {
  resolvePendingReferences,
  type ReferenceBy,
  type ReferenceResolveFailure,
} from "./relations";

export { isReferenceMarker, type ReferenceMarker } from "./schema/reference";

export {
  builtinLoaders,
  defineLoader,
  findLoader,
  resolveLoaders,
  matterLoader,
  yamlLoader,
  jsonLoader,
  type LoadedFile,
  type Loader,
} from "./loaders";

export {
  build,
  buildEffect,
  resolveConfigPath,
  type BuildOptions,
  type BuildResult,
  type BuildError,
  type BuiltSource,
} from "./build";

export {
  watch,
  watchEffect,
  type WatchController,
  type WatchHandlers,
  type WatchOptions,
} from "./watch";

export {
  formatAnhurError,
  ConfigNotFoundError,
  ConfigInvalidError,
  LocalizationConfigError,
  SingletonMissingError,
  SingletonAmbiguousError,
  ValidationFailedError,
  TransformFailedError,
  ReferenceFailedError,
  LoaderNotFoundError,
  LoaderFailedError,
  type ValidationIssue,
  type AnhurError,
} from "./errors";

export { validateWithSchema } from "./validate";

export {
  ConfigLoader,
  type LoadConfigResult,
  type LoadConfigError,
} from "./services/config-loader";
export {
  ContentCollector,
  type CollectedDocument,
  type CollectError,
} from "./services/content-collector";
export { Generator } from "./services/generator";
export { Builder } from "./services/builder";
export { Watcher } from "./services/watcher";
export { layer as nodeLiveLayer } from "./layers/node-live";
