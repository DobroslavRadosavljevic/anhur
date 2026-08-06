import type { AnhurConfig, AnyContent } from "./config";
import type { BuiltContentSnapshot } from "./transform-types";

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
  | IntegrationDefinition;

/**
 * Create the deferred config entry returned by a package factory.
 * This is for integration package authors; app configs call `orama()` or the
 * equivalent package factory directly.
 */
export function createIntegrationConfigEntry<
  TContent extends readonly AnyContent[],
  TId extends string,
>(id: TId, options: object): IntegrationConfigEntry<TContent, TId> {
  if (!id) {
    throw new Error(
      "@anhur/core: createIntegrationConfigEntry requires a non-empty id.",
    );
  }

  return (<_TResolve>() => ({
    id,
    ...options,
  })) as unknown as IntegrationConfigEntry<TContent, TId>;
}

export type IntegrationHandler = {
  readonly id: string;
  readonly run: (
    options: Record<string, unknown>,
    context: IntegrationRuntimeContext,
  ) => void | Promise<void>;
};

const handlers = new Map<string, IntegrationHandler>();

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
  handlers.set(handler.id, handler);
}

export function getIntegrationHandler(
  id: string,
): IntegrationHandler | undefined {
  return handlers.get(id);
}

/** Test helper — clears registered integration handlers. */
export function clearIntegrationHandlers(): void {
  handlers.clear();
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
  value: unknown,
): value is { id: string } & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string"
  );
}

/**
 * Run all config integrations after codegen.
 * Prefers `onComplete` on the entry; otherwise uses a registered handler.
 */
export async function runIntegrations(
  integrations: readonly unknown[] | undefined,
  context: IntegrationRuntimeContext,
): Promise<void> {
  if (!integrations?.length) return;

  for (const configuredEntry of integrations) {
    const entry =
      typeof configuredEntry === "function"
        ? configuredEntry()
        : configuredEntry;

    if (!isPlainIntegrationEntry(entry)) {
      throw new Error(
        "@anhur/core: each integrations[] item must resolve to an object with a string id.",
      );
    }

    const definition = entry as IntegrationDefinition & Record<string, unknown>;
    if (typeof definition.onComplete === "function") {
      await definition.onComplete(context);
      continue;
    }

    const handler = getIntegrationHandler(definition.id);
    if (!handler) {
      throw new Error(
        `@anhur/core: unknown integration "${definition.id}". Import the package that registers it (e.g. \`import "@anhur/orama"\`), or use defineIntegration({ onComplete }).`,
      );
    }

    const { id: _id, onComplete: _onComplete, ...options } = definition;
    await handler.run(options, context);
  }
}
