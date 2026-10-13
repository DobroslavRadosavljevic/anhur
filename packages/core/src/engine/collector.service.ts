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
import type { CompileFieldSpec, LoadedFile } from "../plugin/types";
import { installedVersion } from "../plugin/versions";
import {
  formatPattern,
  walkInput,
  type FieldOccurrence,
  type PatternSegment,
} from "../schema/walk";
import { listContentFiles, type ContentFile } from "./content-files";
import {
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
  type DocumentShares,
  type EffectRecorder,
  type FieldSession,
} from "./field-context";
import { FieldCache, type CachedDependency } from "./field-cache.service";
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
/** Costly documents that must wait before worker threads are started. */
const WORKER_MIN_DOCUMENTS = 128;
/**
 * One worker is started per this many waiting documents (two at least): a
 * worker loads the compilers again, which costs memory and start time…
 */
const WORKER_DOCUMENTS_EACH = 200;
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
  /** Key in the document store, when the document is kept there. */
  readonly storeKey: string | undefined;
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
};

/** A document validated just now, with what the caches keep about it. */
export type FreshDocument = {
  readonly document: ValidatedDocument;
  /** `context.warn()` messages. */
  readonly warnings: readonly string[];
  /** Size and mtime of the files the document used. */
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

function watchedOf(
  file: string,
  signature: FileSignature | undefined,
): CachedDependency {
  return signature
    ? { path: file, mtimeMs: signature.mtimeMs, size: signature.size }
    : { path: file, mtimeMs: -1, size: -1 };
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

/**
 * True when whole documents of `source` may be kept on disk: every
 * compiled field says its value only depends on what the engine tracks.
 */
function isStorable(source: ResolvedSource): boolean {
  if (source.definition.documentCache === false) return false;
  return source.analysis.fields.every(
    (field) =>
      field.spec.type !== "compile" ||
      field.spec.cache !== undefined ||
      field.spec.pure === true,
  );
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
 * Number of worker threads to validate `stale` with (`0`: none). Starting a
 * worker loads the config and the compilers again, so workers are used
 * only when enough costly documents wait.
 */
function workersFor(
  project: ResolvedProject,
  stale: readonly StaleFile[],
): number {
  const setting = project.config.workers;
  if (setting === false || stale.length < WORKER_MIN_DOCUMENTS) return 0;
  const costly = new Map<ResolvedSource, boolean>();
  let waiting = 0;
  for (const entry of stale) {
    const source = entry.file.source;
    let known = costly.get(source);
    if (known === undefined) {
      known = isCostly(source);
      costly.set(source, known);
    }
    if (known) waiting += 1;
  }
  if (waiting < WORKER_MIN_DOCUMENTS) return 0;
  // A number is the most to use; the size of the work still decides.
  const most = Predicate.isNumber(setting)
    ? setting
    : Math.min(WORKER_MAX, Math.max(1, availableParallelism() - 1));
  const wanted = Math.max(
    WORKER_MIN,
    Math.ceil(waiting / WORKER_DOCUMENTS_EACH),
  );
  return Math.min(most, wanted);
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

/** True when every dependency still has the size and mtime it had. */
async function dependenciesMatch(
  session: FieldSession,
  dependencies: readonly CachedDependency[],
): Promise<boolean> {
  for (const dependency of dependencies) {
    const now = watchedOf(
      dependency.path,
      await signatureOf(session.stats, dependency.path),
    );
    if (now.mtimeMs !== dependency.mtimeMs || now.size !== dependency.size) {
      return false;
    }
  }
  return true;
}

/** {@link dependenciesMatch} without waiting. */
function dependenciesMatchSync(
  session: FieldSession,
  dependencies: readonly CachedDependency[],
): boolean {
  for (const dependency of dependencies) {
    const now = watchedOf(
      dependency.path,
      signatureOfSync(session.stats, dependency.path),
    );
    if (now.mtimeMs !== dependency.mtimeMs || now.size !== dependency.size) {
      return false;
    }
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
    !dependenciesMatchSync(session, cached.dependencies)
  ) {
    return undefined;
  }
  return {
    kind: "reused",
    document: cached.document,
    warnings: cached.warnings,
    restored: false,
  };
}

/** The shares of a document, with the keys its fields announce. */
function announcedShares(
  session: FieldSession,
  file: SourceFile,
  body: string | undefined,
  occurrences: readonly (FieldOccurrence & {
    readonly spec: CompileFieldSpec;
  })[],
): DocumentShares {
  const shares = createDocumentShares();
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
  return shares;
}

/** Access to the document store for one build. */
type StoreAccess = {
  readonly cacheDir: string;
  /** Store key of a document; `undefined` when its source is not stored. */
  readonly keyOf: (file: SourceFile) => string | undefined;
  /** Everything besides the file content a stored document depends on. */
  readonly stampOf: (file: SourceFile) => string;
};

/**
 * The document store of a build. A stored document is only valid for the
 * same versions, config, asset URLs, document location and field cache
 * keys (which cover the options of `markdown()`, `mdx()`, …).
 */
function storeAccess(
  project: ResolvedProject,
  session: FieldSession,
): StoreAccess | undefined {
  const cacheDir = project.cacheDir;
  if (cacheDir === undefined) return undefined;
  // The config fingerprint covers the config file and the modules it
  // imports by relative path. Loaders and plugins are fingerprinted too
  // (options, source of functions), like each schema below: they may come
  // from another package.
  const base = sha256(
    JSON.stringify([
      STORE_STAMP_VERSION,
      CORE_VERSION,
      ZOD_VERSION,
      project.fingerprint,
      session.publicBase ?? null,
      fingerprint(project.loaders),
      fingerprint(project.plugins),
    ]),
  );
  /** Per source and file extension; `null` when the source is not stored. */
  const fieldStamps = new Map<string, string | null>();
  const fieldStamp = (file: SourceFile): string | null => {
    const key = `${file.source.name}\u0000${file.meta.extension}`;
    const known = fieldStamps.get(key);
    if (known !== undefined) return known;
    let stamp: string | null = null;
    if (isStorable(file.source)) {
      const recorder = createEffectRecorder();
      try {
        const parts = file.source.analysis.fields.flatMap((field) => {
          const spec = field.spec;
          if (spec.type !== "compile") return [];
          const location = formatPattern(field.pattern);
          if (!spec.cache) {
            return [[location, spec.kind, fingerprint(spec.compile)]];
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
        stamp = sha256(JSON.stringify([file.source.schemaFingerprint, parts]));
      } catch {
        // A cache key that cannot be computed here: do not store the source.
        stamp = null;
      }
    }
    fieldStamps.set(key, stamp);
    return stamp;
  };
  return {
    cacheDir,
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
  };
}

/**
 * True when the files a stored document used are as they were. A file with
 * the same size and (settled) mtime is trusted; an asset whose stat changed
 * (a fresh checkout) is hashed again and must give the same URL.
 */
async function storedEffectsValid(
  session: FieldSession,
  stored: StoredDocument,
): Promise<boolean> {
  const assets = new Map(
    stored.assets.map((asset) => [asset.sourcePath, asset]),
  );
  const recorder = createEffectRecorder();
  const sameAsset = async (sourcePath: string): Promise<boolean> => {
    const asset = assets.get(sourcePath);
    if (!asset) return false;
    try {
      const again = await emitAssetFile(session, sourcePath, recorder);
      return again.hash === asset.hash && again.src === asset.src;
    } catch {
      return false;
    }
  };
  const proven = new Set<string>();
  for (const dependency of stored.watched) {
    const now = await signatureOf(session.stats, dependency.path);
    if (
      now !== undefined &&
      now.size === dependency.size &&
      now.mtimeMs === dependency.mtimeMs &&
      isSettled(now.mtimeMs, stored.readAt)
    ) {
      proven.add(dependency.path);
      continue;
    }
    if (!(await sameAsset(dependency.path))) return false;
    proven.add(dependency.path);
  }
  for (const sourcePath of assets.keys()) {
    if (!proven.has(sourcePath) && !(await sameAsset(sourcePath))) return false;
  }
  return true;
}

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
  store: StoreAccess | undefined,
  now: number,
): Promise<CheckedFile> {
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
    if (!(await dependenciesMatch(session, cached.dependencies))) {
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
    };
  }

  const storeKey = store?.keyOf(file);
  if (!store || storeKey === undefined || signature === undefined) {
    return stale();
  }
  const stored = await readStoredDocument(store.cacheDir, storeKey);
  if (!stored || stored.stamp !== store.stampOf(file)) return stale();
  let readAt = stored.readAt;
  if (!provesUnchanged(stored.signature, signature, stored.readAt)) {
    if (!(await hashIs(stored.hash))) return stale();
    readAt = now;
  }
  if (!(await storedEffectsValid(session, stored))) return stale();
  const document: ValidatedDocument = {
    file,
    hash: stored.hash,
    draft: stored.draft,
    data: deepFreeze(stored.data),
    effects: {
      assets: stored.assets,
      dependencies: stored.dependencies,
      cacheKeys: stored.cacheKeys,
    },
  };
  const dependencies = await Promise.all(
    stored.watched.map(async (dependency) =>
      watchedOf(
        dependency.path,
        await signatureOf(session.stats, dependency.path),
      ),
    ),
  );
  const warnings = warningsOf(file, stored.warnings);
  cache.set(key, {
    hash: stored.hash,
    projectFingerprint: project.fingerprint,
    publicBase: session.publicBase,
    dependencies,
    document,
    warnings,
    signature,
    readAt,
    storeKey,
  });
  return { kind: "reused", document, warnings, restored: true };
}

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
              watchedOf(file, await signatureOf(session.stats, file)),
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
          try: () => listContentFiles(root, { include, exclude, skip }),
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
            const found = (yield* isDirectory(base))
              ? (yield* globFiles(project, base, source.include, [])).files
              : [];
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

      const compileField = Effect.fn("Collector.compileField")(function* (
        project: ResolvedProject,
        session: FieldSession,
        file: SourceFile,
        body: string | undefined,
        occurrence: FieldOccurrence & { readonly spec: CompileFieldSpec },
        recorder: EffectRecorder,
        cacheKeys: Set<string>,
        options: ValidateOptions,
        bodyHash: string | null,
        shares: DocumentShares,
      ) {
        const spec = occurrence.spec;
        const fieldRecorder = createEffectRecorder();
        const context = createFieldContext(
          session,
          file,
          body,
          occurrence.path,
          fieldRecorder,
          shares,
        );
        const fail = (message: string, cause?: unknown) =>
          errorDiagnostic("field-failed", `${spec.kind}: ${message}`, {
            file: file.absPath,
            source: file.source.name,
            fieldPath: occurrence.path,
            cause,
          });
        const merge = () => {
          mergeEffects(fieldRecorder, recorder);
        };

        let cacheKey: string | undefined;
        const cacheSpec = spec.cache;
        if (cacheSpec && project.cacheDir) {
          const plugin = spec.requires
            ? project.plugins.find(
                (candidate) => candidate.name === spec.requires,
              )
            : undefined;
          cacheKey = fingerprint([
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
          const hit = yield* fieldCache.read(project.cacheDir, cacheKey);
          if (
            Option.isSome(hit) &&
            (yield* dependenciesUnchanged(session, hit.value.dependencies))
          ) {
            const entry = hit.value;
            const replayed = yield* withTimeout(
              Effect.tryPromise({
                try: async () => {
                  for (const asset of entry.assets) {
                    const again = await emitAssetFile(
                      session,
                      asset.sourcePath,
                      fieldRecorder,
                    );
                    if (again.hash !== asset.hash) return false;
                  }
                  for (const dependency of entry.dependencies) {
                    fieldRecorder.dependencies.add(dependency.path);
                  }
                  fieldRecorder.warnings.push(...entry.warnings);
                  return true;
                },
                catch: () => fail("cache replay failed"),
              }),
              "1 minute",
              fail(`cache replay did not finish within ${LOAD_TIMEOUT}`),
            ).pipe(Effect.orElseSucceed(() => false));
            if (replayed) {
              merge();
              cacheKeys.add(cacheKey);
              return entry.value;
            }
            fieldRecorder.assets.clear();
            fieldRecorder.dependencies.clear();
            fieldRecorder.warnings.length = 0;
          }
        }

        const value = yield* withTimeout(
          Effect.tryPromise({
            try: async (): Promise<DocumentValue> =>
              spec.compile(occurrence.value, context),
            catch: (cause) => fail(messageOf(cause), cause),
          }),
          "5 minutes",
          fail(`did not finish within ${FIELD_TIMEOUT}`),
        );
        merge();
        // Values the cache cannot round-trip (class instances) are not cached;
        // validation reports them with the field path.
        if (cacheKey !== undefined && project.cacheDir && canCache(value)) {
          if (!options.dryRun) {
            const dependencies = yield* watch(
              session,
              fieldRecorder.dependencies,
            );
            yield* fieldCache.write(project.cacheDir, cacheKey, {
              value,
              assets: [...fieldRecorder.assets.values()].map((asset) => ({
                sourcePath: asset.sourcePath,
                hash: asset.hash,
              })),
              dependencies,
              warnings: [...fieldRecorder.warnings],
            });
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
        const shares = announcedShares(session, file, loaded.body, occurrences);
        const compiled = yield* Effect.forEach(
          occurrences,
          (occurrence) =>
            compileField(
              project,
              session,
              file,
              loaded.body,
              occurrence,
              recorder,
              cacheKeys,
              options,
              bodyHash,
              shares,
            ).pipe(
              Effect.map((value) => ({ ok: true as const, occurrence, value })),
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
            cacheKeys: document.effects.cacheKeys,
            warnings,
          };
          yield* fileWork(() =>
            writeStoredDocument(store.cacheDir, storeKey, entry),
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
            prepareDocumentStore(store.cacheDir).catch(() => undefined),
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
       * Validate stale files in worker threads when that pays off, the rest
       * (and whatever the workers did not finish) here.
       */
      const validateSpread = Effect.fn("Collector.validateSpread")(function* (
        project: ResolvedProject,
        stale: readonly StaleFile[],
        session: FieldSession,
        options: ValidateOptions,
        readAt: number,
      ) {
        const warnings: Diagnostic[] = [];
        const workers = workersFor(project, stale);
        if (workers === 0) {
          return {
            results: yield* validateStale(
              project,
              stale,
              session,
              options,
              readAt,
            ),
            warnings,
          };
        }
        const outcome = yield* poolWork(() =>
          validateInWorkers(
            {
              rootDir: project.projectDir,
              configPath: project.configPath,
              mode: project.mode,
              fingerprint: project.fingerprint,
              publicBase: session.publicBase,
              assetRoots: session.assetRoots,
            },
            stale.map(toWireFile),
            { workers, dryRun: options.dryRun, readAt },
          ),
        );
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
        const results: FreshResult[] = [];
        results.length = stale.length;
        const left: number[] = [];
        for (const [index, entry] of stale.entries()) {
          const result = outcome.results[index];
          if (result === undefined) left.push(index);
          else results[index] = fromWireResult(entry.file, result);
        }
        const here = yield* validateStale(
          project,
          left.map((index) => stale[index]!),
          session,
          options,
          readAt,
        );
        for (const [position, index] of left.entries()) {
          results[index] = here[position]!;
        }
        return { results, warnings };
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
        const settled = yield* fileWork(() =>
          mapPool(unsettled, CHECK_CONCURRENCY, (index) =>
            checkFile(project, files[index]!, session, cache, store, readAt),
          ),
        );
        for (const [position, index] of unsettled.entries()) {
          checked[index] = settled[position]!;
        }
        const stale: StaleFile[] = [];
        for (const entry of checked) {
          if (entry.kind === "stale") {
            stale.push(entry);
            // A failed validation must not leave an older result to be reused later.
            cache.delete(documentCacheKey(entry.file));
          } else if (entry.restored) changed = true;
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
          cache.set(documentCacheKey(entry.file), {
            hash: result.document.hash,
            projectFingerprint: project.fingerprint,
            publicBase: session.publicBase,
            dependencies: result.dependencies,
            document: result.document,
            warnings,
            signature: entry.signature,
            readAt,
            storeKey: result.storeKey,
          });
          documents.push(result.document);
          diagnostics.push(...warnings);
        }
        return { documents, diagnostics, changed };
      });

      return Collector.of({ discover, validate, validateStale });
    }),
  );
}
