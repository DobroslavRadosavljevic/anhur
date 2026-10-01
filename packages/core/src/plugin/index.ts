/**
 * `@anhur/core/plugin` — APIs for plugin and field authors.
 */
export {
  definePlugin,
  defineLoader,
  defineContentPlugin,
  resolvePluginInput,
} from "./define";
export { defineField, readFieldSpec, FIELD_META_KEY } from "../schema/field";
export {
  classifyUrl,
  isDocumentLinkPath,
  isAssetLinkPath,
  hasDotSegment,
  parseSrcset,
  serializeSrcset,
  assetFileName,
  type UrlClass,
  type SrcsetCandidate,
} from "./links";
export {
  rehypeLinkedAssets,
  type LinkedAssetsOptions,
  type DocumentLink,
  type DocumentLinkResolver,
} from "./linked-assets";
export { fingerprint } from "../engine/fingerprint";
export { contentTypeForExtension, contentTypeForPath } from "../mime";
export {
  joinPublicAssetBase,
  resolveAssetBases,
  isRemoteUrl,
} from "../engine/asset-urls";
export {
  toPlainText,
  countWords,
  truncateText,
  parseBody,
  type BodySyntax,
} from "../schema/text";
export {
  buildToc,
  collectHastHeadings,
  extractHeadings,
  tocFromHeadings,
  type TocEntry,
  type TocOptions,
} from "../schema/toc";
export { installedVersion } from "./versions";
export type {
  AnhurPlugin,
  AssetHost,
  AssetRef,
  AssetsInfo,
  BodyHeading,
  BuildMode,
  CompileFieldSpec,
  ContentPlugin,
  EmittedModule,
  FieldContext,
  FieldDocument,
  FieldInput,
  FieldSpec,
  HeadingExtractor,
  LinkRole,
  LoadedFile,
  Loader,
  PluginGenerateContext,
  PluginInput,
  PluginPublishContext,
  PluginSetupContext,
  ReferenceFieldSpec,
  ResolvedLink,
  SourceSnapshot,
  UniqueFieldSpec,
  UniqueOptions,
} from "./types";
export type { AnyContent, TransformDocument } from "../define/types";
export type { DocumentFields, DocumentValue, ContentMeta } from "../document";
