import { Predicate } from "effect";
import type { AnhurConfig, AnyContent } from "./config";
import type { BuiltContentSnapshot } from "./transform-types";
import type { DocumentFields } from "./document-fields";

/**
 * Runtime context passed to integration `onComplete` hooks and registered
 * handlers after codegen succeeds.
 */
export type IntegrationRuntimeContext = {
  /** Absolute path to the config file directory. */
  rootDir: string;
  /** Absolute path to the generated output directory. */
  outputDir: string;
  /** Final documents per content source (after transforms / prepare). */
  sources: BuiltContentSnapshot[];
  /** Resolved project config. */
  config: AnhurConfig;
};

/**
 * Runnable one-off integration. Package helpers such as `orama()` return
 * config entry resolvers instead.
 */
export type IntegrationDefinition = {
  readonly id: string;
  /**
   * Runs after codegen and per-source `onSuccess` hooks, before the optional
   * user `complete` hook.
   */
  readonly onComplete: (
    context: IntegrationRuntimeContext,
  ) => void | Promise<void>;
};

declare const integrationContentType: unique symbol;
declare const integrationResolverType: unique symbol;

/**
 * Shared type-only contract returned by package integration factories.
 *
 * The generic function shape makes TypeScript defer a nested factory call
 * until `defineConfig` has inferred the sibling `content` array. Package
 * factories return a function that resolves to `{ id, ...options }` at build
 * time; the two hidden properties exist only in the type system.
 */
export type IntegrationConfigEntry<
  TContent extends readonly AnyContent[],
  TId extends string = string,
> = <TResolve>() => {
  readonly id: TId;
  readonly [integrationContentType]: TContent;
  readonly [integrationResolverType]: TResolve;
};

/**
 * Values allowed in `defineConfig({ integrations })`.
 * Package factories return {@link IntegrationConfigEntry};
 * {@link IntegrationDefinition} covers custom one-off hooks.
 */
export type IntegrationInput<TContent extends readonly AnyContent[]> =
  | IntegrationConfigEntry<TContent>
  | IntegrationDefinition
  | (DocumentFields & { readonly id: string });

/**
 * Create the deferred config entry returned by a package factory.
 * This is for integration package authors; app configs call `orama()` or the
 * equivalent package factory directly.
 */
export type IntegrationFactoryOptions = DocumentFields;

export function createIntegrationConfigEntry<
  TContent extends readonly AnyContent[],
  TId extends string,
>(
  id: TId,
  options: IntegrationFactoryOptions,
): IntegrationConfigEntry<TContent, TId> {
  if (!id) {
    throw new Error(
      "@anhur/core: createIntegrationConfigEntry requires a non-empty id.",
    );
  }

  // SAFETY: the extra phantom keys exist only in the type system; runtime value is `{ id, ...options }`.
  return (<_TResolve>() => ({
    id,
    ...options,
  })) as IntegrationConfigEntry<TContent, TId>;
}

export type IntegrationHandler = {
  readonly id: string;
  readonly run: (
    options: DocumentFields,
    context: IntegrationRuntimeContext,
  ) => void | Promise<void>;
};

const GLOBAL_HANDLERS_KEY = "__anhur_integration_handlers__" as const;

type GlobalHandlers = typeof globalThis & {
  [GLOBAL_HANDLERS_KEY]?: Map<string, IntegrationHandler>;
};

/** Shared across jiti + host duplicates of this module. */
function getHandlers(): Map<string, IntegrationHandler> {
  // SAFETY: preserves the existing runtime contract for this assignment.
  const g = globalThis as GlobalHandlers;
  if (!g[GLOBAL_HANDLERS_KEY]) {
    g[GLOBAL_HANDLERS_KEY] = new Map();
  }
  return g[GLOBAL_HANDLERS_KEY];
}

/**
 * Register a runner for config entries `{ id, ...options }` that do not carry
 * their own `onComplete`. Package helpers should call this at module load.
 */
export function registerIntegration(handler: IntegrationHandler): void {
  if (!handler.id) {
    throw new Error(
      "@anhur/core: registerIntegration requires a non-empty id.",
    );
  }
  getHandlers().set(handler.id, handler);
}

export function getIntegrationHandler(
  id: string,
): IntegrationHandler | undefined {
  return getHandlers().get(id);
}

/** Test helper — clears registered integration handlers. */
export function clearIntegrationHandlers(): void {
  getHandlers().clear();
}

/**
 * Define a one-off or package integration with an explicit `onComplete` hook.
 * Does not require {@link registerIntegration}.
 */
export function defineIntegration(
  definition: IntegrationDefinition,
): IntegrationDefinition {
  if (!definition.id) {
    throw new Error("@anhur/core: defineIntegration requires a non-empty id.");
  }
  return definition;
}

function isPlainIntegrationEntry(
  value: DocumentFields | IntegrationDefinition,
): value is IntegrationDefinition & DocumentFields {
  return "id" in value && Predicate.isString(value.id);
}

/**
 * Run all config integrations after codegen.
 * Prefers `onComplete` on the entry; otherwise uses a registered handler.
 */
export async function runIntegrations(
  integrations: readonly IntegrationInput<readonly AnyContent[]>[] | undefined,
  context: IntegrationRuntimeContext,
): Promise<void> {
  if (!integrations?.length) return;

  for (const configuredEntry of integrations) {
    const entry = Predicate.isFunction(configuredEntry)
      ? configuredEntry()
      : configuredEntry;

    if (!isPlainIntegrationEntry(entry)) {
      throw new Error(
        "@anhur/core: each integrations[] item must resolve to an object with a string id.",
      );
    }

    if (Predicate.isFunction(entry.onComplete)) {
      await entry.onComplete(context);
      continue;
    }

    const handler = getIntegrationHandler(entry.id);
    if (!handler) {
      throw new Error(
        `@anhur/core: unknown integration "${entry.id}". Import the package that registers it (e.g. \`import "@anhur/orama"\`), or use defineIntegration({ onComplete }).`,
      );
    }

    const { id: _id, onComplete: _onComplete, ...options } = entry;
    await handler.run(options, context);
  }
}
