import { Context, Effect, FileSystem, Layer, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { BuildContext } from "../build-context";
import type {
  AnyCollection,
  AnySingleton,
  ContentMeta,
  AnhurConfig,
  Localization,
} from "../config";
import { resolveLocalization } from "../config";
import {
  LoaderFailedError,
  LoaderNotFoundError,
  LocalizationConfigError,
  SingletonAmbiguousError,
  SingletonMissingError,
  ValidationFailedError,
} from "../errors";
import { findLoader, resolveLoaders } from "../loaders";
import { validateWithSchema } from "../validate";
import { isDocumentFields } from "../document-fields";
import type { DocumentFields } from "../document-fields";

export type CollectedDocument = {
  data: DocumentFields;
  _meta: ContentMeta;
};

export type CollectError =
  | LocalizationConfigError
  | SingletonMissingError
  | SingletonAmbiguousError
  | ValidationFailedError
  | LoaderNotFoundError
  | LoaderFailedError
  | PlatformError;

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function stripExtension(filePath: string, path: Path.Path): string {
  const ext = path.extname(filePath);
  return ext ? filePath.slice(0, -ext.length) : filePath;
}

function toPosix(filePath: string, path: Path.Path): string {
  return filePath.split(path.sep).join("/");
}

const assertLocales = (
  localization: Localization,
): Effect.Effect<void, LocalizationConfigError> =>
  localization.locales.includes(localization.defaultLocale)
    ? Effect.void
    : Effect.fail(
        new LocalizationConfigError({
          detail: `defaultLocale "${localization.defaultLocale}" must be listed in locales.`,
        }),
      );

/**
 * Collects and validates documents for collections and singletons.
 * Document validation runs with concurrency 1 so `schema.unique()` is safe.
 */
export class ContentCollector extends Context.Service<
  ContentCollector,
  {
    readonly collectCollection: (
      collection: AnyCollection,
      rootDir: string,
      config: AnhurConfig,
      buildContext: BuildContext,
    ) => Effect.Effect<CollectedDocument[], CollectError>;
    readonly collectSingleton: (
      singleton: AnySingleton,
      rootDir: string,
      config: AnhurConfig,
      buildContext: BuildContext,
    ) => Effect.Effect<CollectedDocument[], CollectError>;
  }
>()("@anhur/core/ContentCollector") {
  static get layer(): Layer.Layer<
    ContentCollector,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    return createContentCollectorLayer();
  }
}

function createContentCollectorLayer(): Layer.Layer<
  ContentCollector,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Layer.effect(
    ContentCollector,
    Effect.fn("makeContentCollector")(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const globAbsolute = Effect.fn("globAbsolute")(function* (
        patterns: string[],
        options: { cwd: string; exclude?: string[] },
      ) {
        const matches = new Set<string>();
        const exclude =
          options.exclude && options.exclude.length > 0
            ? options.exclude
            : undefined;

        for (const pattern of patterns) {
          const entries = yield* fs.glob(pattern, {
            root: options.cwd,
            exclude,
          });
          for (const entry of entries) {
            matches.add(path.resolve(options.cwd, entry));
          }
        }

        return [...matches].sort();
      });

      const loadFile = Effect.fn("loadFile")(function* (
        filePath: string,
        config: AnhurConfig,
      ) {
        const loaders = resolveLoaders(config.loaders);
        const loader = findLoader(filePath, loaders);
        if (!loader) {
          return yield* Effect.fail(new LoaderNotFoundError({ filePath }));
        }
        const raw = yield* fs.readFileString(filePath);
        return yield* Effect.tryPromise({
          try: async () => loader.load({ path: filePath, raw }),
          catch: (cause) =>
            new LoaderFailedError({
              filePath,
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      });

      const readAndValidate = Effect.fn("readAndValidate")(function* (
        filePath: string,
        id: string,
        schema: AnyCollection["schema"] | AnySingleton["schema"],
        config: AnhurConfig,
        buildContext: BuildContext,
        sourceName: string,
        locale?: string,
      ) {
        const loaded = yield* loadFile(filePath, config);
        const input: DocumentFields = { ...loaded.data };
        if (loaded.content !== undefined) {
          input.content = loaded.content;
        }
        const data = yield* validateWithSchema({
          schema,
          input,
          filePath,
          id,
          config,
          buildContext,
          content: loaded.content,
          sourceName,
          locale,
        });
        if (!isDocumentFields(data)) {
          return yield* Effect.fail(
            new ValidationFailedError({
              filePath,
              issues: [{ message: "schema output must be an object" }],
            }),
          );
        }
        return data;
      });

      const collectCollection = Effect.fn("collectCollection")(function* (
        collection: AnyCollection,
        rootDir: string,
        config: AnhurConfig,
        buildContext: BuildContext,
      ) {
        const localization = resolveLocalization(config, collection);
        const baseDir = path.resolve(rootDir, collection.directory);
        const include = toArray(collection.include);
        const exclude = toArray(collection.exclude);

        if (!localization) {
          const files = yield* globAbsolute(include, {
            cwd: baseDir,
            exclude,
          });
          return yield* Effect.forEach(
            files,
            Effect.fn("collectCollectionFile")(function* (filePath: string) {
              const relativePath = toPosix(
                path.relative(baseDir, filePath),
                path,
              );
              const id = stripExtension(relativePath, path);
              const data = yield* readAndValidate(
                filePath,
                id,
                collection.schema,
                config,
                buildContext,
                collection.name,
              );
              const meta = {
                id,
                filePath,
                relativePath,
                extension: path.extname(filePath),
              } satisfies ContentMeta;
              return { data, _meta: meta } satisfies CollectedDocument;
            }),
            { concurrency: 1 },
          );
        }

        yield* assertLocales(localization);

        const perLocale = yield* Effect.forEach(
          localization.locales,
          Effect.fn("collectCollectionLocale")(function* (locale: string) {
            const localeDir = path.join(baseDir, locale);
            const files = yield* globAbsolute(include, {
              cwd: localeDir,
              exclude,
            });

            return yield* Effect.forEach(
              files,
              Effect.fn("collectCollectionLocaleFile")(function* (
                filePath: string,
              ) {
                const relativeInLocale = toPosix(
                  path.relative(localeDir, filePath),
                  path,
                );
                const relativePath = toPosix(
                  path.relative(baseDir, filePath),
                  path,
                );
                const id = stripExtension(relativeInLocale, path);
                const data = yield* readAndValidate(
                  filePath,
                  id,
                  collection.schema,
                  config,
                  buildContext,
                  collection.name,
                  locale,
                );
                const meta = {
                  id,
                  filePath,
                  relativePath,
                  extension: path.extname(filePath),
                  locale,
                } satisfies ContentMeta;
                return { data, _meta: meta } satisfies CollectedDocument;
              }),
              { concurrency: 1 },
            );
          }),
          { concurrency: 1 },
        );

        return perLocale.flat();
      });

      const collectSingleton = Effect.fn("collectSingleton")(function* (
        singleton: AnySingleton,
        rootDir: string,
        config: AnhurConfig,
        buildContext: BuildContext,
      ) {
        const localization = resolveLocalization(config, singleton);

        if (!localization) {
          const filePath = path.resolve(rootDir, singleton.filePath!);
          const exists = yield* fs.exists(filePath);

          if (!exists) {
            if (singleton.optional) return [];
            return yield* Effect.fail(
              new SingletonMissingError({
                name: singleton.name,
                path: filePath,
              }),
            );
          }

          const id = singleton.name;
          const data = yield* readAndValidate(
            filePath,
            id,
            singleton.schema,
            config,
            buildContext,
            singleton.name,
          );
          const meta = {
            id,
            filePath,
            relativePath: toPosix(path.basename(filePath), path),
            extension: path.extname(filePath),
          } satisfies ContentMeta;
          return [{ data, _meta: meta } satisfies CollectedDocument];
        }

        yield* assertLocales(localization);

        if (!singleton.directory) {
          return yield* Effect.fail(
            new LocalizationConfigError({
              detail: `Singleton "${singleton.name}" requires directory.`,
            }),
          );
        }

        const baseDir = path.resolve(rootDir, singleton.directory);
        const include = toArray(singleton.include ?? "index.{md,mdx}");
        const docs: CollectedDocument[] = [];

        for (const locale of localization.locales) {
          const localeDir = path.join(baseDir, locale);
          const files = yield* globAbsolute(include, { cwd: localeDir });

          if (files.length === 0) {
            if (locale === localization.defaultLocale && !singleton.optional) {
              return yield* Effect.fail(
                new SingletonMissingError({
                  name: singleton.name,
                  path: `${localeDir} (include: ${include.join(", ")})`,
                }),
              );
            }
            continue;
          }

          if (files.length > 1) {
            return yield* Effect.fail(
              new SingletonAmbiguousError({
                name: singleton.name,
                locale,
                files,
              }),
            );
          }

          const filePath = files[0]!;
          const relativePath = toPosix(path.relative(baseDir, filePath), path);
          const id = singleton.name;
          const data = yield* readAndValidate(
            filePath,
            id,
            singleton.schema,
            config,
            buildContext,
            singleton.name,
            locale,
          );
          const meta = {
            id,
            filePath,
            relativePath,
            extension: path.extname(filePath),
            locale,
          } satisfies ContentMeta;
          docs.push({ data, _meta: meta });
        }

        return docs;
      });

      return ContentCollector.of({ collectCollection, collectSingleton });
    })(),
  );
}
