import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
} from "effect";
import type { z } from "zod";
import {
  errorDiagnostic,
  messageOf,
  warningDiagnostic,
  type Diagnostic,
} from "../diagnostics";
import {
  isPlainObject,
  writePath,
  type ContentMeta,
  type DocumentFields,
  type DocumentValue,
  type FieldPath,
} from "../document";
import { builtinLoaders, findLoader } from "../loaders";
import type {
  AssetRef,
  CompileFieldSpec,
  FieldContext,
  LoadedFile,
} from "../plugin/types";
import { installedVersion } from "../plugin/versions";
import {
  formatPattern,
  walkInput,
  type FieldOccurrence,
  type PatternSegment,
} from "../schema/walk";
import { listContentFiles, type ContentFile } from "./content-files";
import {
  documentStoreDir,
  prepareDocumentStore,
  readStoredDocument,
  storedDocumentKey,
  writeStoredDocument,
  type StoredDocument,
} from "./document-store";
import {
  createDocumentShares,
  createEffectRecorder,
  createFieldContext,
  emitAssetFile,
  mergeEffects,
  storedAssetAllowed,
  type DocumentShares,
  type EffectRecorder,
  type FieldSession,
} from "./field-context";
import {
  dependencyOf,
  FieldCache,
  fieldCacheDir,
  sameDependency,
  type CachedDependency,
} from "./field-cache.service";
import {
  isSettled,
  mapPool,
  provesUnchanged,
  signatureOf,
  signatureOfSync,
  type FileSignature,
} from "./file-signature";
import { fileWork } from "./file-work";
import { fingerprint } from "./fingerprint";
import { deepFreeze } from "./freeze";
import { relativeTo, toPosix } from "./paths";
import { canCache } from "./cache-codec";
import { findNonPlainData } from "./plain-data";
import type { ResolvedProject, ResolvedSource } from "./resolve";
import type { DocumentReuse, NotStored } from "./result";
import type { SourceFile, ValidatedDocument } from "./types";
import { poolWork, validateInWorkers } from "./validation-pool";
import {
  fromWireDiagnostic,
  type WireFile,
  type WireResult,
} from "./validation-wire";

const LOAD_TIMEOUT = "1 minute";
const LIST_TIMEOUT = "5 minutes";
const FIELD_TIMEOUT = "5 minutes";
const VALIDATE_TIMEOUT = "5 minutes";
const FILE_CONCURRENCY = 8;
const FIELD_CONCURRENCY = 4;
/** Files checked against the caches at once (stat, read, hash: no user code). */
const CHECK_CONCURRENCY = 48;
/**
 * Blocking stats are used while they are fast: when the first files take
 * longer than this in total, the disk is slow and the rest is checked in
 * parallel instead.
 */
const SLOW_DISK_SAMPLE = 63;
const SLOW_DISK_SAMPLE_MS = 4;
/** Costly documents that must wait before worker threads are thought of. */
const WORKER_MIN_DOCUMENTS = 128;
/**
 * Documents validated in the main thread first, to learn what one costs.
 * The first ones also load the compilers, so only the next ones are timed.
 */
const WORKER_WARM_UP = 8;
const WORKER_SAMPLE = 16;
/**
 * Workers are started when the documents left would take longer than this
 * in the main thread: a worker loads the config and the compilers again,
 * which costs about this much time, and memory…
 */
const WORKER_MIN_ESTIMATE_MS = 1000;
/** …one worker per this much work (two at least)… */
const WORKER_ESTIMATE_EACH_MS = 1500;
const WORKER_MIN = 2;
/** …up to this many (and one less than the available CPU cores). */
const WORKER_MAX = 6;
/** Part of every field cache key: a core upgrade can change field output. */
const CORE_VERSION = installedVersion("@anhur/core", import.meta.url);
/** Part of every stored document: a Zod upgrade can change schema output. */
const ZOD_VERSION = installedVersion("zod", import.meta.url);
/** Bump when the meaning of a stored document changes. */
const STORE_STAMP_VERSION = 1;

/** Key of a document in the session cache: the same file may belong to several sources. */
export function documentCacheKey(file: SourceFile): string {
  return `${file.source.name}\u0000${file.absPath}`;
}

/** A validated document remembered between builds of one session. */
export type CachedDocument = {
  readonly hash: string;
  readonly projectFingerprint: string;
  readonly publicBase: string | undefined;
  readonly dependencies: readonly CachedDependency[];
  readonly document: ValidatedDocument;
  /** Warnings of the validation that produced `document`, replayed on reuse. */
  readonly warnings: readonly Diagnostic[];
  /** Signature of the file when its content was read (`undefined`: unknown). */
  readonly signature: FileSignature | undefined;
  /** Epoch milliseconds, taken before the content was read. */
  readonly readAt: number;
  /** Epoch milliseconds, taken before `dependencies` were looked at. */
  readonly dependenciesAt: number;
  /** Key in the document store, when the document is kept there. */
  readonly storeKey: string | undefined;
  /** False when the store does not hold the document yet (it was made by a dry run). */
  readonly stored: boolean;
};

/** Per-build options of {@link Collector.validate}. */
export type ValidateOptions = {
  /** `anhur check`: read the caches, never write them. */
  readonly dryRun: boolean;
};

export type DiscoverResult = {
  readonly files: readonly SourceFile[];
  readonly diagnostics: readonly Diagnostic[];
};

export type ValidateResult = {
  readonly documents: readonly ValidatedDocument[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * False when every document was reused from the session cache and no
   * document went away: nothing a later stage reads has changed.
   */
  readonly changed: boolean;
  /**
   * Sources whose documents are not kept on disk although the document
   * store is on (a field or loader that is not pure, a schema without a
   * fingerprint). Empty for sources that set `documentCache: false`.
   */
  readonly notStored: readonly NotStored[];
  readonly reuse: DocumentReuse;
};

/** A document validated just now, with what the caches keep about it. */
export type FreshDocument = {
  readonly document: ValidatedDocument;
  /** `context.warn()` messages. */
  readonly warnings: readonly string[];
  /** State of the files the document used. */
  readonly dependencies: readonly CachedDependency[];
  /** Key in the document store, when the document is kept there. */
  readonly storeKey: string | undefined;
};

export type FreshResult =
  | ({ readonly ok: true } & FreshDocument)
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** A file that has to be loaded, compiled and validated. */
export type StaleFile = {
  readonly file: SourceFile;
  /** File text and its hash, when the cache check already read it. */
  readonly raw: string | undefined;
  readonly hash: string | undefined;
  readonly signature: FileSignature | undefined;
};

type CheckedFile =
  | {
      readonly kind: "reused";
      readonly document: ValidatedDocument;
      readonly warnings: readonly Diagnostic[];
      /** Not from the session cache: later stages must treat it as new. */
      readonly restored: boolean;
      /** True when the file was read to compare its content. */
      readonly compared: boolean;
    }
  | ({ readonly kind: "stale" } & StaleFile);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stripExtension(relative: string): string {
  const slash = relative.lastIndexOf("/");
  const dot = relative.lastIndexOf(".");
  return dot > slash + 1 ? relative.slice(0, dot) : relative;
}

function warningsOf(
  file: SourceFile,
  messages: readonly string[],
): Diagnostic[] {
  return messages.map((message) =>
    warningDiagnostic("field-failed", message, {
      file: file.absPath,
      source: file.source.name,
    }),
  );
}

/** A concrete path for a static field location (`tags[]` → `["tags", 0]`). */
function samplePath(pattern: readonly PatternSegment[]): FieldPath {
  return pattern.map((segment) =>
    segment.kind === "key"
      ? segment.key
      : segment.kind === "item"
        ? (segment.index ?? 0)
        : "",
  );
}

/** Whether whole documents of a source may be kept on disk. */
type StoreRule =
  | { readonly kind: "store" }
  /** The config turns it off: nothing to report. */
  | { readonly kind: "off" }
  | { readonly kind: "blocked"; readonly reason: string };

/** The key of a pure field's options (`""` when it has none); `undefined`: not pure. */
function pureKey(spec: CompileFieldSpec): string | undefined {
  const pure = spec.pure;
  if (pure === true) return "";
  if (Predicate.isObject(pure) && Predicate.isString(pure.key)) return pure.key;
  return undefined;
}

/**
 * Documents of `source` may be kept on disk when its schema has a
 * fingerprint and every compiled field says its value only depends on what
 * the engine tracks.
 */
function storeRule(source: ResolvedSource): StoreRule {
  if (source.definition.documentCache === false) return { kind: "off" };
  const problem = source.schemaFingerprint.problem;
  if (problem !== undefined) return { kind: "blocked", reason: problem };
  for (const field of source.analysis.fields) {
    const spec = field.spec;
    if (
      spec.type === "compile" &&
      spec.cache === undefined &&
      pureKey(spec) === undefined
    ) {
      return {
        kind: "blocked",
        reason: `the field "${formatPattern(field.pattern)}" (${spec.kind}) is not pure and has no cache`,
      };
    }
  }
  return { kind: "store" };
}

function issuePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((segment) =>
    Predicate.isNumber(segment) ? segment : String(segment),
  );
}

/**
 * Sources whose documents are costly to validate: a field with `cache`
 * compiles something (Markdown, MDX, an image).
 */
function isCostly(source: ResolvedSource): boolean {
  return source.analysis.fields.some(
    (field) => field.spec.type === "compile" && field.spec.cache !== undefined,
  );
}

/**
 * True when documents of `source` may be validated in a worker thread: the
 * work is costly, and a worker that loads the config again gets the same
 * schema. A source that sets `documentCache: false` reads something besides
 * its files, and a schema without a fingerprint is new on every read: both
 * are validated here, with one config.
 */
function mayUseWorkers(source: ResolvedSource): boolean {
  return (
    isCostly(source) &&
    source.definition.documentCache !== false &&
    source.schemaFingerprint.value !== undefined
  );
}

/**
 * Number of worker threads for work the main thread would need
 * `estimateMs` for (`0`: none), when the config leaves the choice to the
 * engine. One worker does not make the work faster (the main thread only
 * waits for it), so fewer than two are never started.
 */
function workersFor(estimateMs: number): number {
  if (estimateMs < WORKER_MIN_ESTIMATE_MS) return 0;
  const most = Math.min(WORKER_MAX, availableParallelism() - 1);
  const wanted = Math.max(
    WORKER_MIN,
    Math.ceil(estimateMs / WORKER_ESTIMATE_EACH_MS),
  );
  const count = Math.min(most, wanted);
  return count < WORKER_MIN ? 0 : count;
}

function toWireFile(stale: StaleFile): WireFile {
  const file = stale.file;
  return {
    source: file.source.name,
    absPath: file.absPath,
    id: file.id,
    locale: file.locale,
    meta: file.meta,
    raw: stale.raw,
    hash: stale.hash,
    signature: stale.signature,
  };
}

function fromWireResult(file: SourceFile, result: WireResult): FreshResult {
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map(fromWireDiagnostic),
    };
  }
  return {
    ok: true,
    document: {
      file,
      hash: result.hash,
      draft: result.draft,
      data: deepFreeze(result.data),
      effects: result.effects,
    },
    warnings: result.warnings,
    dependencies: result.dependencies,
    storeKey: result.storeKey,
  };
}

/**
 * True when a dependency recorded at `recordedAt` is proved unchanged by
 * its state now. Without `recordedAt` the same state is enough (the field
 * cache, which has no time of its own).
 */
function dependencyUnchanged(
  dependency: CachedDependency,
  now: CachedDependency,
  recordedAt: number | undefined,
): boolean {
  return (
    sameDependency(dependency, now) &&
    (recordedAt === undefined || isSettled(dependency.mtimeMs, recordedAt))
  );
}

/** True when every dependency is as it was (see {@link dependencyUnchanged}). */
async function dependenciesMatch(
  session: FieldSession,
  dependencies: readonly CachedDependency[],
  recordedAt?: number,
): Promise<boolean> {
  for (const dependency of dependencies) {
    const now = dependencyOf(
      dependency.path,
      await signatureOf(session.stats, dependency.path),
    );
    if (!dependencyUnchanged(dependency, now, recordedAt)) return false;
  }
  return true;
}

/** {@link dependenciesMatch} without waiting. */
function dependenciesMatchSync(
  session: FieldSession,
  dependencies: readonly CachedDependency[],
  recordedAt: number,
): boolean {
  for (const dependency of dependencies) {
    const now = dependencyOf(
      dependency.path,
      signatureOfSync(session.stats, dependency.path),
    );
    if (!dependencyUnchanged(dependency, now, recordedAt)) return false;
  }
  return true;
}

/**
 * The document of an earlier build of this session, when stats alone prove
 * that the file and everything it used are unchanged. `undefined`: the
 * file needs {@link checkFile}. This is the whole cost of an unchanged
 * document in a rebuild.
 */
function reuseUnchanged(
  project: ResolvedProject,
  file: SourceFile,
  session: FieldSession,
  cache: Map<string, CachedDocument>,
): CheckedFile | undefined {
  const cached = cache.get(documentCacheKey(file));
  if (
    !cached ||
    cached.signature === undefined ||
    cached.document.file !== file ||
    cached.projectFingerprint !== project.fingerprint ||
    cached.publicBase !== session.publicBase
  ) {
    return undefined;
  }
  const signature = signatureOfSync(session.stats, file.absPath);
  if (
    signature === undefined ||
    !provesUnchanged(cached.signature, signature, cached.readAt) ||
    !dependenciesMatchSync(session, cached.dependencies, cached.dependenciesAt)
  ) {
    return undefined;
  }
  return {
    kind: "reused",
    document: cached.document,
    warnings: cached.warnings,
    restored: false,
    compared: false,
  };
}

/**
 * Add the keys the fields in `occurrences` announce to `shares`. Only
 * fields that are about to compile are passed: a field whose value comes
 * from the field cache does no work another field could join.
 */
function announceShares(
  shares: DocumentShares,
  session: FieldSession,
  file: SourceFile,
  body: string | undefined,
  occurrences: readonly (FieldOccurrence & {
    readonly spec: CompileFieldSpec;
  })[],
): void {
  for (const occurrence of occurrences) {
    const announce = occurrence.spec.shares;
    if (!announce) continue;
    try {
      const context = createFieldContext(
        session,
        file,
        body,
        occurrence.path,
        createEffectRecorder(),
        shares,
      );
      for (const key of announce(context)) shares.announced.add(key);
    } catch {
      // Nothing announced: the other fields do their own work.
    }
  }
}

/** Access to the document store for one build. */
type StoreAccess = {
  /** Folder of the stored documents of this build mode. */
  readonly dir: string;
  /** Store key of a document; `undefined` when it is not stored. */
  readonly keyOf: (file: SourceFile) => string | undefined;
  /** Everything besides the file content a stored document depends on. */
  readonly stampOf: (file: SourceFile) => string;
  /** The sources found not storable so far, one reason each. */
  readonly notStored: () => readonly NotStored[];
};

/** The part of every stamp that is the same for all builds of a project. */
const projectStamps = new WeakMap<ResolvedProject, string>();

function projectStamp(project: ResolvedProject): string {
  let stamp = projectStamps.get(project);
  if (stamp === undefined) {
    // The project fingerprint covers the config file, every module it
    // imports that is not an installed package, the lockfile and the
    // schemas. Loaders and plugins are fingerprinted too (options, source
    // of functions): they may be made by an installed package.
    stamp = sha256(
      JSON.stringify([
        STORE_STAMP_VERSION,
        CORE_VERSION,
        ZOD_VERSION,
        project.fingerprint,
        fingerprint(project.loaders),
        fingerprint(project.plugins),
      ]),
    );
    projectStamps.set(project, stamp);
  }
  return stamp;
}

/** One store access per build: the session of a build is its identity. */
const storeAccesses = new WeakMap<FieldSession, StoreAccess | null>();

/**
 * The document store of a build. A stored document is only valid for the
 * same versions, config, schema, loader, asset URLs, document location and
 * field keys (which cover the options of `markdown()`, `mdx()`, …).
 */
function storeAccess(
  project: ResolvedProject,
  session: FieldSession,
): StoreAccess | undefined {
  const known = storeAccesses.get(session);
  if (known !== undefined) return known ?? undefined;
  const access = makeStoreAccess(project, session);
  storeAccesses.set(session, access ?? null);
  return access;
}

function makeStoreAccess(
  project: ResolvedProject,
  session: FieldSession,
): StoreAccess | undefined {
  const cacheDir = project.cacheDir;
  if (cacheDir === undefined) return undefined;
  const base = sha256(
    JSON.stringify([projectStamp(project), session.publicBase ?? null]),
  );
  const loaders = [...project.loaders, ...builtinLoaders];
  const reasons = new Map<string, string>();
  const block = (source: ResolvedSource, reason: string): null => {
    if (!reasons.has(source.name)) reasons.set(source.name, reason);
    return null;
  };
  /** Per source and loader; `null` when such documents are not stored. */
  const fieldStamps = new Map<string, string | null>();
  const fieldStamp = (file: SourceFile): string | null => {
    const source = file.source;
    const loader = findLoader(file.absPath, loaders);
    const loaderAt = loader ? loaders.indexOf(loader) : -1;
    const key = `${source.name}\u0000${file.meta.extension}\u0000${String(loaderAt)}`;
    const known = fieldStamps.get(key);
    if (known !== undefined) return known;
    let stamp: string | null = null;
    const rule = storeRule(source);
    if (rule.kind === "blocked") {
      stamp = block(source, rule.reason);
    } else if (rule.kind === "store" && !project.sourcesComplete) {
      stamp = block(
        source,
        "the config imports more modules than Anhur follows, so a change in one of them could go unseen",
      );
    } else if (rule.kind === "store" && loader && loader.pure !== true) {
      stamp = block(
        source,
        `the "${loader.name}" loader of ${file.meta.extension} files is not pure`,
      );
    } else if (rule.kind === "store" && loader) {
      const recorder = createEffectRecorder();
      try {
        const parts = source.analysis.fields.flatMap((field) => {
          const spec = field.spec;
          if (spec.type !== "compile") return [];
          const location = formatPattern(field.pattern);
          if (!spec.cache) {
            // Known by its source and by the key of its options.
            return [
              [location, spec.kind, fingerprint(spec.compile), pureKey(spec)],
            ];
          }
          const context = createFieldContext(
            session,
            file,
            undefined,
            samplePath(field.pattern),
            recorder,
          );
          return [
            [location, spec.kind, spec.cache.version, spec.cache.key(context)],
          ];
        });
        stamp = sha256(
          JSON.stringify([source.schemaFingerprint.value, loader.name, parts]),
        );
      } catch (cause) {
        stamp = block(
          source,
          `a field cache key could not be made (${messageOf(cause)})`,
        );
      }
    }
    fieldStamps.set(key, stamp);
    return stamp;
  };
  return {
    dir: documentStoreDir(cacheDir, project.mode),
    keyOf: (file) =>
      fieldStamp(file) === null
        ? undefined
        : storedDocumentKey(file.source.name, file.meta.filePath),
    stampOf: (file) =>
      [
        base,
        fieldStamp(file) ?? "",
        file.source.name,
        file.id,
        file.locale ?? "",
        file.meta.filePath,
        file.meta.relativePath,
        file.meta.extension,
      ].join("\u0000"),
    notStored: () =>
      [...reasons.entries()].map(([source, reason]) => ({ source, reason })),
  };
}

/**
 * The assets of a stored document when the files it used are as they were,
 * else `undefined`. A file with the same state as then (size, times and
 * inode, with a settled mtime) is trusted; an asset whose state changed (a
 * fresh checkout) is hashed again and must give the same URL. `rehashed`
 * is set when a file had to be read for that.
 */
async function storedEffects(
  session: FieldSession,
  stored: StoredDocument,
): Promise<
  | { readonly assets: readonly AssetRef[]; readonly rehashed: boolean }
  | undefined
> {
  const assets = new Map(
    stored.assets.map((asset) => [asset.sourcePath, asset]),
  );
  const recorder = createEffectRecorder();
  let rehashed = false;
  /** The asset as this build sees it, when it is the stored one. */
  const sameAsset = async (
    sourcePath: string,
  ): Promise<AssetRef | undefined> => {
    const asset = assets.get(sourcePath);
    if (!asset) return undefined;
    rehashed = true;
    try {
      const again = await emitAssetFile(session, sourcePath, recorder);
      return again.hash === asset.hash &&
        again.src === asset.src &&
        again.sourcePath === asset.sourcePath
        ? again
        : undefined;
    } catch {
      return undefined;
    }
  };
  const proven = new Map<string, AssetRef | undefined>();
  for (const dependency of stored.watched) {
    const signature = await signatureOf(session.stats, dependency.path);
    const now = dependencyOf(dependency.path, signature);
    const asset = assets.get(dependency.path);
    if (dependencyUnchanged(dependency, now, stored.watchedAt)) {
      if (!asset) {
        proven.set(dependency.path, undefined);
        continue;
      }
      // The entry is a file on disk: it may only name what the rules allow.
      if (
        signature?.isFile === true &&
        asset.size === signature.size &&
        (await storedAssetAllowed(session, asset))
      ) {
        proven.set(dependency.path, asset);
        continue;
      }
      return undefined;
    }
    const again = await sameAsset(dependency.path);
    if (!again) return undefined;
    proven.set(dependency.path, again);
  }
  const result: AssetRef[] = [];
  for (const sourcePath of assets.keys()) {
    const asset = proven.has(sourcePath)
      ? proven.get(sourcePath)
      : await sameAsset(sourcePath);
    if (!asset) return undefined;
    result.push(asset);
  }
  return { assets: result, rehashed };
}

/** What the document store keeps of a document of this session. */
function storedEntryOf(
  store: StoreAccess,
  cached: CachedDocument,
  signature: FileSignature,
): StoredDocument {
  const document = cached.document;
  return {
    stamp: store.stampOf(document.file),
    hash: cached.hash,
    signature,
    readAt: cached.readAt,
    draft: document.draft,
    data: document.data,
    assets: document.effects.assets,
    dependencies: document.effects.dependencies,
    watched: cached.dependencies,
    watchedAt: cached.dependenciesAt,
    cacheKeys: document.effects.cacheKeys,
    warnings: cached.warnings.map((warning) => warning.message),
  };
}

/** Options of {@link checkFile}. */
type CheckOptions = {
  readonly store: StoreAccess | undefined;
  /** Epoch milliseconds, taken before any file of the build was looked at. */
  readonly now: number;
  /** False in a dry run: the store is read, never written. */
  readonly persist: boolean;
};

/**
 * Decide whether a file needs validation: reuse the document of an earlier
 * build of this session, or of an earlier session (document store), when
 * the file and everything it used are unchanged. Never rejects.
 */
async function checkFile(
  project: ResolvedProject,
  file: SourceFile,
  session: FieldSession,
  cache: Map<string, CachedDocument>,
  options: CheckOptions,
): Promise<CheckedFile> {
  const { store, now } = options;
  const key = documentCacheKey(file);
  const signature = await signatureOf(session.stats, file.absPath);
  let raw: string | undefined;
  let hash: string | undefined;
  const hashIs = async (expected: string): Promise<boolean> => {
    if (raw === undefined) {
      try {
        raw = await readFile(file.absPath, "utf8");
      } catch {
        return false;
      }
      hash = sha256(raw);
    }
    return hash === expected;
  };
  const stale = (): CheckedFile => ({
    kind: "stale",
    file,
    raw,
    hash,
    signature,
  });

  const cached = cache.get(key);
  if (cached) {
    if (
      cached.projectFingerprint !== project.fingerprint ||
      cached.publicBase !== session.publicBase ||
      cached.document.file.id !== file.id ||
      cached.document.file.locale !== file.locale
    ) {
      return stale();
    }
    let entry = cached;
    const proven =
      signature !== undefined &&
      cached.signature !== undefined &&
      provesUnchanged(cached.signature, signature, cached.readAt);
    if (!proven) {
      if (!(await hashIs(cached.hash))) return stale();
      entry = { ...cached, signature, readAt: now };
    }
    if (
      !(await dependenciesMatch(
        session,
        cached.dependencies,
        cached.dependenciesAt,
      ))
    ) {
      return stale();
    }
    // A reloaded config creates new source objects: rebind to them.
    const document =
      cached.document.file.source === file.source
        ? cached.document
        : { ...cached.document, file };
    if (entry !== cached || document !== cached.document) {
      cache.set(key, { ...entry, document });
    }
    return {
      kind: "reused",
      document,
      warnings: cached.warnings,
      restored: document !== cached.document,
      compared: raw !== undefined,
    };
  }

  const storeKey = store?.keyOf(file);
  if (!store || storeKey === undefined || signature === undefined) {
    return stale();
  }
  const stored = await readStoredDocument(store.dir, storeKey);
  if (!stored || stored.stamp !== store.stampOf(file)) return stale();
  const statProven = provesUnchanged(
    stored.signature,
    signature,
    stored.readAt,
  );
  if (!statProven && !(await hashIs(stored.hash))) return stale();
  const effects = await storedEffects(session, stored);
  if (!effects) return stale();
  const document: ValidatedDocument = {
    file,
    hash: stored.hash,
    draft: stored.draft,
    data: deepFreeze(stored.data),
    effects: {
      assets: effects.assets,
      dependencies: stored.dependencies,
      cacheKeys: stored.cacheKeys,
    },
  };
  const warnings = warningsOf(file, stored.warnings);
  // A file that had to be read to prove it unchanged (new times after a
  // checkout) is recorded as it is now, so the next session needs no read.
  const refresh = !statProven || effects.rehashed;
  const entry: CachedDocument = {
    hash: stored.hash,
    projectFingerprint: project.fingerprint,
    publicBase: session.publicBase,
    dependencies: refresh
      ? await Promise.all(
          stored.watched.map(async (dependency) =>
            dependencyOf(
              dependency.path,
              await signatureOf(session.stats, dependency.path),
            ),
          ),
        )
      : stored.watched,
    document,
    warnings,
    signature,
    readAt: statProven ? stored.readAt : now,
    dependenciesAt: refresh ? now : stored.watchedAt,
    storeKey,
    stored: true,
  };
  cache.set(key, entry);
  if (refresh && options.persist && isSettled(signature.mtimeMs, now)) {
    await writeStoredDocument(
      store.dir,
      storeKey,
      storedEntryOf(store, entry, signature),
    );
  }
  return {
    kind: "reused",
    document,
    warnings,
    restored: true,
    compared: raw !== undefined || effects.rehashed,
  };
}

/** One compiled field of a document after its field cache lookup. */
type FieldAttempt = {
  readonly occurrence: FieldOccurrence & { readonly spec: CompileFieldSpec };
  readonly context: FieldContext;
  /** What the field reported: replayed from the cache entry, or filled by the compile. */
  readonly recorder: EffectRecorder;
  /** Key in the field cache; `undefined` when the field is not cached. */
  readonly cacheKey: string | undefined;
  readonly hit: { readonly value: DocumentValue } | undefined;
};

/** Apply a timeout to user / plugin code, failing with a diagnostic. */
function withTimeout<A>(
  effect: Effect.Effect<A, Diagnostic>,
  duration: "1 minute" | "5 minutes",
  diagnostic: Diagnostic,
): Effect.Effect<A, Diagnostic> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(diagnostic),
    }),
  );
}

/**
 * Finds content files and turns each into a validated document: load →
 * compile fields (with an explicit context) → Zod. Files are processed in
 * parallel; every problem becomes a diagnostic.
 */
export class Collector extends Context.Service<
  Collector,
  {
    readonly discover: (
      project: ResolvedProject,
    ) => Effect.Effect<DiscoverResult>;
    readonly validate: (
      project: ResolvedProject,
      files: readonly SourceFile[],
      session: FieldSession,
      cache: Map<string, CachedDocument>,
      options: ValidateOptions,
    ) => Effect.Effect<ValidateResult>;
    /**
     * Load, compile and validate files, whatever the caches say. One
     * result per file, in order. Validation workers call this.
     */
    readonly validateStale: (
      project: ResolvedProject,
      stale: readonly StaleFile[],
      session: FieldSession,
      options: ValidateOptions,
      readAt: number,
    ) => Effect.Effect<FreshResult[]>;
  }
>()("@anhur/core/engine/Collector") {
  static readonly layer = Layer.effect(
    Collector,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fieldCache = yield* FieldCache;

      const isDirectory = (target: string) =>
        fs.stat(target).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );

      /** Size and mtime of files a document depends on, as they are now. */
      const watch = (session: FieldSession, files: Iterable<string>) =>
        fileWork(() =>
          Promise.all(
            [...files].map(async (file) =>
              dependencyOf(file, await signatureOf(session.stats, file)),
            ),
          ),
        );

      const dependenciesUnchanged = (
        session: FieldSession,
        dependencies: readonly CachedDependency[],
      ) => fileWork(() => dependenciesMatch(session, dependencies));

      const globFiles = Effect.fn("Collector.globFiles")(function* (
        project: ResolvedProject,
        root: string,
        include: readonly string[],
        exclude: readonly string[],
      ) {
        const failures: Diagnostic[] = [];
        const skip = [project.outputDir];
        if (project.cacheDir !== undefined) skip.push(project.cacheDir);
        const files = yield* Effect.tryPromise({
          // The signal stops the listing when the build is interrupted or
          // the time limit below ends it.
          try: (signal) =>
            listContentFiles(root, {
              include,
              exclude,
              skip,
              signal,
              onSkip: (folder, reason) => {
                failures.push(
                  warningDiagnostic(
                    "read-failed",
                    `The folder ${relativeTo(project.projectDir, folder)} was left out: ${reason}.`,
                    {
                      hint: "Its files are not part of the build. Fix the permissions or exclude the folder.",
                    },
                  ),
                );
              },
            }),
          catch: (cause) =>
            errorDiagnostic(
              "read-failed",
              `Could not list the files in ${root}: ${messageOf(cause)}`,
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: LIST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                errorDiagnostic(
                  "read-failed",
                  `Listing the files in ${root} did not finish within ${LIST_TIMEOUT}.`,
                ),
              ),
          }),
          Effect.catch((failure) =>
            Effect.sync((): ContentFile[] => {
              failures.push(failure);
              return [];
            }),
          ),
        );
        return { files, failures };
      });

      const makeFile = (
        project: ResolvedProject,
        source: ResolvedSource,
        absPath: string,
        idBase: string,
        locale: string | undefined,
        id: string,
      ): SourceFile => {
        const meta: ContentMeta = {
          id,
          filePath: relativeTo(project.projectDir, absPath),
          relativePath: toPosix(path.relative(idBase, absPath)),
          extension: path.extname(absPath),
        };
        if (locale !== undefined) meta.locale = locale;
        // Shared by every document object that carries `_meta`.
        Object.freeze(meta);
        return { source, absPath, id, locale, meta };
      };

      /**
       * Files of the last discovery. A file found again for the same source
       * and locale keeps its object (and its id and `_meta`).
       */
      let knownFiles = new Map<string, SourceFile>();
      const knownFile = (
        source: ResolvedSource,
        absPath: string,
        locale: string | undefined,
      ): SourceFile | undefined => {
        const known = knownFiles.get(`${source.name}\u0000${absPath}`);
        return known && known.source === source && known.locale === locale
          ? known
          : undefined;
      };

      const discoverCollection = Effect.fn("Collector.discoverCollection")(
        function* (
          project: ResolvedProject,
          source: Extract<ResolvedSource, { kind: "collection" }>,
        ) {
          const diagnostics: Diagnostic[] = [];
          const files: SourceFile[] = [];
          if (!(yield* isDirectory(source.root))) {
            diagnostics.push(
              errorDiagnostic(
                "source-missing",
                `Collection "${source.name}" folder does not exist: ${relativeTo(project.projectDir, source.root)}`,
                {
                  source: source.name,
                  hint: "Create the folder or fix directory in defineCollection().",
                },
              ),
            );
            return { files, diagnostics };
          }
          const localeNames: readonly string[] = source.localized
            ? (project.localization?.locales ?? [])
            : [];
          const locales: readonly (string | undefined)[] = source.localized
            ? localeNames
            : [undefined];
          if (source.localized) {
            const entries = yield* fs
              .readDirectory(source.root)
              .pipe(Effect.orElseSucceed((): string[] => []));
            const stray = entries.filter(
              (entry) => !entry.startsWith(".") && !localeNames.includes(entry),
            );
            if (stray.length > 0) {
              diagnostics.push(
                warningDiagnostic(
                  "source-missing",
                  `Collection "${source.name}" is localized; these entries are not inside a locale folder and are ignored: ${stray.slice(0, 10).join(", ")}`,
                  {
                    source: source.name,
                    hint: `Move files into ${localeNames.map((locale) => `${locale}/`).join(", ")} or set localized: false.`,
                  },
                ),
              );
            }
          }
          const seen = new Map<string, string>();
          for (const locale of locales) {
            const base =
              locale === undefined
                ? source.root
                : path.join(source.root, locale);
            if (locale !== undefined && !(yield* isDirectory(base))) continue;
            const { files: found, failures } = yield* globFiles(
              project,
              base,
              source.include,
              source.exclude,
            );
            diagnostics.push(
              ...failures.map((failure) => ({
                ...failure,
                source: source.name,
              })),
            );
            for (const { absolute: absPath, relative } of found) {
              const known = knownFile(source, absPath, locale);
              // NFC: macOS / some editors write decomposed names, references are typed composed.
              const id = known?.id ?? stripExtension(relative).normalize("NFC");
              const key = `${locale ?? ""}\u0000${id.toLowerCase()}`;
              const previous = seen.get(key);
              if (previous !== undefined) {
                diagnostics.push(
                  errorDiagnostic(
                    "duplicate-id",
                    `"${relativeTo(project.projectDir, absPath)}" and "${relativeTo(project.projectDir, previous)}" both map to the document id "${id}"${locale ? ` (${locale})` : ""}.`,
                    {
                      file: absPath,
                      source: source.name,
                      hint: "Ids come from the path without extension, compared case-insensitively. Rename one file.",
                    },
                  ),
                );
                continue;
              }
              seen.set(key, absPath);
              files.push(
                known ??
                  makeFile(project, source, absPath, source.root, locale, id),
              );
            }
          }
          return { files, diagnostics };
        },
      );

      const discoverSingleton = Effect.fn("Collector.discoverSingleton")(
        function* (
          project: ResolvedProject,
          source: Extract<ResolvedSource, { kind: "singleton" }>,
        ) {
          const diagnostics: Diagnostic[] = [];
          const files: SourceFile[] = [];
          const optional = source.definition.optional === true;
          if (!source.localized) {
            const filePath = source.filePath!;
            const info = yield* fs.stat(filePath).pipe(Effect.option);
            if (Option.isNone(info) || info.value.type !== "File") {
              if (!optional) {
                diagnostics.push(
                  errorDiagnostic(
                    "singleton-missing",
                    `Singleton "${source.name}" file not found: ${relativeTo(project.projectDir, filePath)}`,
                    {
                      source: source.name,
                      hint: "Create the file, fix filePath, or set optional: true.",
                    },
                  ),
                );
              }
              return { files, diagnostics };
            }
            files.push(
              knownFile(source, filePath, undefined) ??
                makeFile(
                  project,
                  source,
                  filePath,
                  path.dirname(filePath),
                  undefined,
                  source.name,
                ),
            );
            return { files, diagnostics };
          }
          const localization = project.localization!;
          for (const locale of localization.locales) {
            const base = path.join(source.root, locale);
            const listed = (yield* isDirectory(base))
              ? yield* globFiles(project, base, source.include, [])
              : undefined;
            const found = listed?.files ?? [];
            diagnostics.push(
              ...(listed?.failures ?? []).map((failure) => ({
                ...failure,
                source: source.name,
              })),
            );
            if (found.length === 0) {
              if (locale === localization.defaultLocale && !optional) {
                diagnostics.push(
                  errorDiagnostic(
                    "singleton-missing",
                    `Singleton "${source.name}" has no file for the default locale "${locale}" in ${relativeTo(project.projectDir, base)} (include: ${source.include.join(", ")}).`,
                    {
                      source: source.name,
                      hint: "Add the file or set optional: true.",
                    },
                  ),
                );
              }
              continue;
            }
            if (found.length > 1) {
              diagnostics.push(
                errorDiagnostic(
                  "singleton-ambiguous",
                  `Singleton "${source.name}" matches several files for "${locale}": ${found.map((file) => relativeTo(project.projectDir, file.absolute)).join(", ")}`,
                  {
                    source: source.name,
                    hint: "Keep one file per locale or narrow include.",
                  },
                ),
              );
              continue;
            }
            const absPath = found[0]!.absolute;
            files.push(
              knownFile(source, absPath, locale) ??
                makeFile(
                  project,
                  source,
                  absPath,
                  source.root,
                  locale,
                  source.name,
                ),
            );
          }
          return { files, diagnostics };
        },
      );

      const discover = Effect.fn("Collector.discover")(function* (
        project: ResolvedProject,
      ) {
        const results = yield* Effect.forEach(
          project.sources,
          (source) =>
            source.kind === "collection"
              ? discoverCollection(project, source)
              : discoverSingleton(project, source),
          { concurrency: 4 },
        );
        const files = results.flatMap((result) => result.files);
        knownFiles = new Map(
          files.map((file) => [
            `${file.source.name}\u0000${file.absPath}`,
            file,
          ]),
        );
        return {
          files,
          diagnostics: results.flatMap((result) => result.diagnostics),
        };
      });

      const loadFile = Effect.fn("Collector.loadFile")(function* (
        project: ResolvedProject,
        file: SourceFile,
        raw: string,
      ) {
        const loader = findLoader(file.absPath, [
          ...project.loaders,
          ...builtinLoaders,
        ]);
        if (!loader) {
          return yield* Effect.fail(
            errorDiagnostic(
              "loader-missing",
              `No loader reads "${file.meta.extension}" files.`,
              {
                file: file.absPath,
                source: file.source.name,
                hint: "Narrow include to .md/.mdx/.yml/.yaml/.json, or add a loader.",
              },
            ),
          );
        }
        const loaded: LoadedFile = yield* withTimeout(
          Effect.tryPromise({
            try: async () => loader.load({ path: file.absPath, raw }),
            catch: (cause) =>
              errorDiagnostic(
                "loader-failed",
                `${loader.name} loader failed: ${messageOf(cause)}`,
                {
                  file: file.absPath,
                  source: file.source.name,
                  cause,
                },
              ),
          }),
          "1 minute",
          errorDiagnostic(
            "loader-failed",
            `${loader.name} loader did not finish within ${LOAD_TIMEOUT}.`,
            {
              file: file.absPath,
            },
          ),
        );
        if (!Predicate.isObject(loaded) || !isPlainObject(loaded.data)) {
          return yield* Effect.fail(
            errorDiagnostic(
              "loader-failed",
              `${loader.name} loader must return { data: object, body?: string }.`,
              {
                file: file.absPath,
              },
            ),
          );
        }
        const problem = findNonPlainData(loaded.data);
        if (problem) {
          return yield* Effect.fail(
            errorDiagnostic(
              "loader-failed",
              `${loader.name} loader returned data that ${problem.message}.`,
              { file: file.absPath, fieldPath: problem.fieldPath },
            ),
          );
        }
        return loaded;
      });

      /**
       * Look one compiled field up in the field cache. Never fails: a field
       * that is not cached, or whose entry cannot be used, has no `hit`.
       */
      const lookupField = Effect.fn("Collector.lookupField")(function* (
        project: ResolvedProject,
        session: FieldSession,
        file: SourceFile,
        body: string | undefined,
        occurrence: FieldOccurrence & { readonly spec: CompileFieldSpec },
        bodyHash: string | null,
        shares: DocumentShares,
      ) {
        const spec = occurrence.spec;
        const recorder = createEffectRecorder();
        const context = createFieldContext(
          session,
          file,
          body,
          occurrence.path,
          recorder,
          shares,
        );
        const miss = (cacheKey: string | undefined): FieldAttempt => ({
          occurrence,
          context,
          recorder,
          cacheKey,
          hit: undefined,
        });
        const cacheSpec = spec.cache;
        if (!cacheSpec || !project.cacheDir) return miss(undefined);
        const plugin = spec.requires
          ? project.plugins.find(
              (candidate) => candidate.name === spec.requires,
            )
          : undefined;
        const cacheKey = fingerprint([
          CORE_VERSION,
          spec.kind,
          cacheSpec.version,
          plugin?.version ?? "",
          cacheSpec.key(context),
          occurrence.value,
          occurrence.path,
          // The body is hashed once per document, not once per field.
          bodyHash,
          file.meta,
          project.mode,
          session.publicBase ?? null,
        ]);
        const hit = yield* fieldCache.read(
          fieldCacheDir(project.cacheDir, project.mode),
          cacheKey,
        );
        if (
          Option.isNone(hit) ||
          !(yield* dependenciesUnchanged(session, hit.value.dependencies))
        ) {
          return miss(cacheKey);
        }
        const entry = hit.value;
        const replayed = yield* fileWork(async () => {
          try {
            for (const asset of entry.assets) {
              const again = await emitAssetFile(
                session,
                asset.sourcePath,
                recorder,
              );
              if (again.hash !== asset.hash) return false;
            }
            return true;
          } catch {
            return false;
          }
        });
        if (!replayed) {
          recorder.assets.clear();
          return miss(cacheKey);
        }
        for (const dependency of entry.dependencies) {
          recorder.dependencies.add(dependency.path);
        }
        recorder.warnings.push(...entry.warnings);
        const attempt: FieldAttempt = {
          occurrence,
          context,
          recorder,
          cacheKey,
          hit: { value: entry.value },
        };
        return attempt;
      });

      /** The value of a field: from its cache hit, or compiled now. */
      const finishField = Effect.fn("Collector.finishField")(function* (
        project: ResolvedProject,
        session: FieldSession,
        file: SourceFile,
        attempt: FieldAttempt,
        recorder: EffectRecorder,
        cacheKeys: Set<string>,
        options: ValidateOptions,
      ) {
        const { occurrence, context, cacheKey } = attempt;
        const spec = occurrence.spec;
        const fieldRecorder = attempt.recorder;
        if (attempt.hit) {
          mergeEffects(fieldRecorder, recorder);
          if (cacheKey !== undefined) cacheKeys.add(cacheKey);
          return attempt.hit.value;
        }
        const fail = (message: string, cause?: unknown) =>
          errorDiagnostic("field-failed", `${spec.kind}: ${message}`, {
            file: file.absPath,
            source: file.source.name,
            fieldPath: occurrence.path,
            cause,
          });
        const value = yield* withTimeout(
          Effect.tryPromise({
            try: async (): Promise<DocumentValue> =>
              spec.compile(occurrence.value, context),
            catch: (cause) => fail(messageOf(cause), cause),
          }),
          "5 minutes",
          fail(`did not finish within ${FIELD_TIMEOUT}`),
        );
        mergeEffects(fieldRecorder, recorder);
        // Values the cache cannot round-trip (class instances) are not cached;
        // validation reports them with the field path.
        if (cacheKey !== undefined && project.cacheDir && canCache(value)) {
          if (!options.dryRun) {
            const dependencies = yield* watch(
              session,
              fieldRecorder.dependencies,
            );
            yield* fieldCache.write(
              fieldCacheDir(project.cacheDir, project.mode),
              cacheKey,
              {
                value,
                assets: [...fieldRecorder.assets.values()].map((asset) => ({
                  sourcePath: asset.sourcePath,
                  hash: asset.hash,
                })),
                dependencies,
                warnings: [...fieldRecorder.warnings],
              },
            );
          }
          cacheKeys.add(cacheKey);
        }
        return value;
      });

      /**
       * Load, compile and validate one file. `stale` carries what the cache
       * check already read.
       */
      const validateFresh = Effect.fn("Collector.validateFresh")(function* (
        project: ResolvedProject,
        stale: StaleFile,
        session: FieldSession,
        options: ValidateOptions,
        store: StoreAccess | undefined,
        readAt: number,
      ) {
        const file = stale.file;
        const raw =
          stale.raw ??
          (yield* fs.readFileString(file.absPath).pipe(
            Effect.mapError((error) =>
              errorDiagnostic(
                "read-failed",
                `Could not read the file: ${error.message}`,
                {
                  file: file.absPath,
                  source: file.source.name,
                },
              ),
            ),
          ));
        const hash = stale.hash ?? sha256(raw);

        const loaded = yield* loadFile(project, file, raw);
        const input: DocumentFields = structuredClone(loaded.data);
        const schema: z.core.$ZodType = file.source.definition.schema;
        const recorder = createEffectRecorder();
        const cacheKeys = new Set<string>();
        const bodyHash = loaded.body === undefined ? null : sha256(loaded.body);
        const occurrences = walkInput(schema, input).filter(
          (
            occurrence,
          ): occurrence is FieldOccurrence & {
            readonly spec: CompileFieldSpec;
          } =>
            occurrence.spec.type === "compile" &&
            (occurrence.present || occurrence.spec.whenAbsent === "compile"),
        );
        // Cache lookups first: only a field that is about to compile does
        // work another field of the document can join (`context.isShared`).
        const shares = createDocumentShares();
        const attempts = yield* Effect.forEach(
          occurrences,
          (occurrence) =>
            lookupField(
              project,
              session,
              file,
              loaded.body,
              occurrence,
              bodyHash,
              shares,
            ),
          { concurrency: FIELD_CONCURRENCY },
        );
        announceShares(
          shares,
          session,
          file,
          loaded.body,
          attempts
            .filter((attempt) => attempt.hit === undefined)
            .map((attempt) => attempt.occurrence),
        );
        const compiled = yield* Effect.forEach(
          attempts,
          (attempt) =>
            finishField(
              project,
              session,
              file,
              attempt,
              recorder,
              cacheKeys,
              options,
            ).pipe(
              Effect.map((value) => ({
                ok: true as const,
                occurrence: attempt.occurrence,
                value,
              })),
              Effect.catch((diagnostic) =>
                Effect.succeed({ ok: false as const, diagnostic }),
              ),
            ),
          { concurrency: FIELD_CONCURRENCY },
        );
        const fieldDiagnostics: Diagnostic[] = [];
        for (const result of compiled) {
          if (!result.ok) {
            fieldDiagnostics.push(result.diagnostic);
            continue;
          }
          writePath(input, result.occurrence.path, result.value);
        }
        if (fieldDiagnostics.length > 0) {
          return yield* Effect.fail(fieldDiagnostics);
        }

        const parsed = yield* withTimeout(
          Effect.tryPromise({
            try: () => file.source.definition.schema.safeParseAsync(input),
            catch: (cause) =>
              errorDiagnostic(
                "validation-failed",
                `Schema threw: ${messageOf(cause)}`,
                {
                  file: file.absPath,
                  source: file.source.name,
                  cause,
                },
              ),
          }),
          "5 minutes",
          errorDiagnostic(
            "validation-failed",
            `Validation did not finish within ${VALIDATE_TIMEOUT}.`,
            {
              file: file.absPath,
            },
          ),
        ).pipe(Effect.mapError((diagnostic) => [diagnostic]));
        if (!parsed.success) {
          return yield* Effect.fail(
            parsed.error.issues.map((issue) =>
              errorDiagnostic("validation-failed", issue.message, {
                file: file.absPath,
                source: file.source.name,
                fieldPath: issuePath(issue.path),
              }),
            ),
          );
        }
        const data: unknown = parsed.data;
        if (!isPlainObject(data)) {
          return yield* Effect.fail([
            errorDiagnostic(
              "validation-failed",
              "The schema must produce an object.",
              {
                file: file.absPath,
                source: file.source.name,
              },
            ),
          ]);
        }
        const problem = findNonPlainData(data);
        if (problem) {
          return yield* Effect.fail([
            errorDiagnostic(
              "validation-failed",
              `The schema output ${problem.message}.`,
              {
                file: file.absPath,
                source: file.source.name,
                fieldPath: problem.fieldPath,
                hint: "Return plain data from .transform() and custom fields (for example url.href instead of a URL).",
              },
            ),
          ]);
        }
        const document: ValidatedDocument = {
          file,
          hash,
          // `draft: true` in the file counts even when the schema does not declare `draft`.
          draft: loaded.data.draft === true || data.draft === true,
          // Shared by every later build and stage: never changed in place.
          data: deepFreeze(data),
          effects: {
            assets: [...recorder.assets.values()],
            dependencies: [...recorder.dependencies],
            cacheKeys: [...cacheKeys],
          },
        };
        const dependencies = yield* watch(session, [
          ...recorder.dependencies,
          ...recorder.assets.keys(),
        ]);
        // A value two fields share reports its warnings to both: once is enough.
        const warnings = [...new Set(recorder.warnings)];
        const storeKey = store?.keyOf(file);
        if (
          store &&
          storeKey !== undefined &&
          stale.signature !== undefined &&
          !options.dryRun
        ) {
          const entry: StoredDocument = {
            stamp: store.stampOf(file),
            hash,
            signature: stale.signature,
            readAt,
            draft: document.draft,
            data: document.data,
            assets: document.effects.assets,
            dependencies: document.effects.dependencies,
            watched: dependencies,
            watchedAt: readAt,
            cacheKeys: document.effects.cacheKeys,
            warnings,
          };
          yield* fileWork(() =>
            writeStoredDocument(store.dir, storeKey, entry),
          );
        }
        const fresh: FreshDocument = {
          document,
          warnings,
          dependencies,
          storeKey,
        };
        return fresh;
      });

      const validateStale = Effect.fn("Collector.validateStale")(function* (
        project: ResolvedProject,
        stale: readonly StaleFile[],
        session: FieldSession,
        options: ValidateOptions,
        readAt: number,
      ) {
        if (stale.length === 0) return [];
        const store = storeAccess(project, session);
        if (store && !options.dryRun) {
          yield* fileWork(() =>
            prepareDocumentStore(store.dir).catch(() => undefined),
          );
        }
        return yield* Effect.forEach(
          stale,
          (entry) =>
            validateFresh(project, entry, session, options, store, readAt).pipe(
              Effect.map((result): FreshResult => ({ ok: true, ...result })),
              Effect.catch((failure) =>
                Effect.succeed<FreshResult>({
                  ok: false,
                  diagnostics: Array.isArray(failure) ? failure : [failure],
                }),
              ),
            ),
          { concurrency: FILE_CONCURRENCY },
        );
      });

      /**
       * Fingerprint of a project no worker could load (its config fails or
       * hangs in a worker thread). Later builds of that project do not try
       * again: each try costs the start time of the workers.
       */
      let unusableProject: string | undefined;

      /**
       * Validate stale files in worker threads when that pays off, the rest
       * (and whatever the workers did not finish) here.
       *
       * Whether it pays off is measured, not guessed: some of the costly
       * documents are validated here first. When their fields come from the
       * field cache, or the documents are small, the rest is quick here too
       * and no worker is started.
       */
      const validateSpread = Effect.fn("Collector.validateSpread")(function* (
        project: ResolvedProject,
        stale: readonly StaleFile[],
        session: FieldSession,
        options: ValidateOptions,
        readAt: number,
      ) {
        const warnings: Diagnostic[] = [];
        const results: FreshResult[] = [];
        results.length = stale.length;
        /** Validate the files at `indexes` in this thread. */
        const validateHere = Effect.fn("Collector.validateHere")(function* (
          indexes: readonly number[],
        ) {
          const done = yield* validateStale(
            project,
            indexes.map((index) => stale[index]!),
            session,
            options,
            readAt,
          );
          for (const [position, index] of indexes.entries()) {
            results[index] = done[position]!;
          }
        });

        const costly: number[] = [];
        const plain: number[] = [];
        const eligible = new Map<ResolvedSource, boolean>();
        for (const [index, entry] of stale.entries()) {
          const source = entry.file.source;
          let known = eligible.get(source);
          if (known === undefined) {
            known = mayUseWorkers(source);
            eligible.set(source, known);
          }
          (known ? costly : plain).push(index);
        }
        if (
          project.config.workers === false ||
          costly.length < WORKER_MIN_DOCUMENTS ||
          unusableProject === project.fingerprint
        ) {
          yield* validateHere([...stale.keys()]);
          return { results, warnings };
        }

        let rest = costly;
        let workers: number;
        const setting = project.config.workers;
        if (Predicate.isNumber(setting)) {
          // A number in the config is the number to use: nothing to measure.
          workers = setting;
        } else {
          yield* validateHere(costly.slice(0, WORKER_WARM_UP));
          const sample = costly.slice(
            WORKER_WARM_UP,
            WORKER_WARM_UP + WORKER_SAMPLE,
          );
          const started = performance.now();
          yield* validateHere(sample);
          const each = (performance.now() - started) / sample.length;
          rest = costly.slice(WORKER_WARM_UP + WORKER_SAMPLE);
          workers = workersFor(each * rest.length);
        }
        if (workers === 0) {
          yield* validateHere([...rest, ...plain]);
          return { results, warnings };
        }

        const pool = poolWork((signal) =>
          validateInWorkers(
            {
              rootDir: project.projectDir,
              configPath: project.configPath,
              mode: project.mode,
              fingerprint: project.fingerprint,
              publicBase: session.publicBase,
              assetRoots: session.assetRoots,
            },
            rest.map((index) => toWireFile(stale[index]!)),
            { workers, dryRun: options.dryRun, readAt, signal },
          ),
        );
        // The documents workers do not take are validated here meanwhile.
        const [outcome] = yield* Effect.all([pool, validateHere(plain)], {
          concurrency: 2,
        });
        if (outcome.unusable) unusableProject = project.fingerprint;
        if (outcome.problem !== undefined) {
          warnings.push(
            warningDiagnostic(
              "internal",
              `Worker threads could not be used for every document (${outcome.problem}); the rest was compiled in the main thread.`,
              {
                hint: "Set workers: false in defineConfig() to turn them off.",
              },
            ),
          );
        }
        const left: number[] = [];
        for (const [position, index] of rest.entries()) {
          const result = outcome.results[position];
          if (result === undefined) left.push(index);
          else results[index] = fromWireResult(stale[index]!.file, result);
        }
        yield* validateHere(left);
        return { results, warnings };
      });

      /**
       * True while the session cache may hold documents the store does not
       * have: a dry run (`anhur check`, then a build in one session) reads
       * the caches and never writes them.
       */
      let unstored = false;

      /** Write the documents a dry run of this session made to the store. */
      const storeUnstored = Effect.fn("Collector.storeUnstored")(function* (
        project: ResolvedProject,
        store: StoreAccess,
        cache: Map<string, CachedDocument>,
      ) {
        const waiting = [...cache.entries()].filter(
          ([, cached]) =>
            !cached.stored &&
            cached.storeKey !== undefined &&
            cached.signature !== undefined &&
            cached.projectFingerprint === project.fingerprint,
        );
        yield* fileWork(async () => {
          await prepareDocumentStore(store.dir).catch(() => undefined);
          await mapPool(waiting, CHECK_CONCURRENCY, async ([key, cached]) => {
            const { storeKey, signature } = cached;
            if (storeKey === undefined || signature === undefined) return;
            await writeStoredDocument(
              store.dir,
              storeKey,
              storedEntryOf(store, cached, signature),
            );
            // The entry may have been replaced while this one was written.
            if (cache.get(key) === cached) {
              cache.set(key, { ...cached, stored: true });
            }
          });
        });
        unstored = false;
      });

      const validate = Effect.fn("Collector.validate")(function* (
        project: ResolvedProject,
        files: readonly SourceFile[],
        session: FieldSession,
        cache: Map<string, CachedDocument>,
        options: ValidateOptions,
      ) {
        let changed = false;
        const live = new Set(files.map(documentCacheKey));
        for (const key of cache.keys()) {
          if (live.has(key)) continue;
          cache.delete(key);
          changed = true;
        }
        const readAt = yield* Clock.currentTimeMillis;
        const store = storeAccess(project, session);
        // Unchanged documents first, with blocking stats: on a local disk
        // that is faster than waiting for each one. A slow disk (a network
        // or container mount) gets the waiting, parallel form instead.
        const checked: CheckedFile[] = [];
        checked.length = files.length;
        const unsettled: number[] = [];
        let blocking = true;
        const started = performance.now();
        for (let index = 0; index < files.length; index += 1) {
          const reused = blocking
            ? reuseUnchanged(project, files[index]!, session, cache)
            : undefined;
          if (reused) checked[index] = reused;
          else unsettled.push(index);
          if (
            index === SLOW_DISK_SAMPLE &&
            performance.now() - started > SLOW_DISK_SAMPLE_MS
          ) {
            blocking = false;
          }
        }
        if (store && !options.dryRun && unsettled.length > 0) {
          yield* fileWork(() =>
            prepareDocumentStore(store.dir).catch(() => undefined),
          );
        }
        const check: CheckOptions = {
          store,
          now: readAt,
          persist: !options.dryRun,
        };
        const settled = yield* fileWork(() =>
          mapPool(unsettled, CHECK_CONCURRENCY, (index) =>
            checkFile(project, files[index]!, session, cache, check),
          ),
        );
        for (const [position, index] of unsettled.entries()) {
          checked[index] = settled[position]!;
        }
        const stale: StaleFile[] = [];
        let compared = 0;
        for (const entry of checked) {
          if (entry.kind === "stale") {
            stale.push(entry);
            // A failed validation must not leave an older result to be reused later.
            cache.delete(documentCacheKey(entry.file));
            continue;
          }
          if (entry.restored) changed = true;
          if (entry.compared) compared += 1;
        }
        if (stale.length > 0) changed = true;
        const fresh = yield* validateSpread(
          project,
          stale,
          session,
          options,
          readAt,
        );
        const documents: ValidatedDocument[] = [];
        const diagnostics: Diagnostic[] = [...fresh.warnings];
        let next = 0;
        for (const entry of checked) {
          if (entry.kind === "reused") {
            documents.push(entry.document);
            diagnostics.push(...entry.warnings);
            continue;
          }
          const result = fresh.results[next]!;
          next += 1;
          if (!result.ok) {
            diagnostics.push(...result.diagnostics);
            continue;
          }
          const warnings = warningsOf(entry.file, result.warnings);
          // `validateFresh` wrote the store entry, unless this is a dry run.
          const stored =
            result.storeKey !== undefined &&
            entry.signature !== undefined &&
            !options.dryRun;
          if (result.storeKey !== undefined && !stored) unstored = true;
          cache.set(documentCacheKey(entry.file), {
            hash: result.document.hash,
            projectFingerprint: project.fingerprint,
            publicBase: session.publicBase,
            dependencies: result.dependencies,
            document: result.document,
            warnings,
            signature: entry.signature,
            readAt,
            dependenciesAt: readAt,
            storeKey: result.storeKey,
            stored,
          });
          documents.push(result.document);
          diagnostics.push(...warnings);
        }
        if (store && unstored && !options.dryRun) {
          yield* storeUnstored(project, store, cache);
        }
        return {
          documents,
          diagnostics,
          changed,
          notStored: store?.notStored() ?? [],
          reuse: {
            unchanged: checked.length - stale.length - compared,
            compared,
            validated: stale.length,
          },
        };
      });

      return Collector.of({ discover, validate, validateStale });
    }),
  );
}
