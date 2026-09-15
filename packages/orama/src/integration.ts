import { createIntegrationConfigEntry, registerIntegration } from "@anhur/core";
import { buildOramaIndex } from "./build";
import type { AnyContent, IntegrationConfigEntry } from "@anhur/core";
import type { OramaIntegrationOptions } from "./types";

const ORAMA_INTEGRATION_ID = "orama" as const;

function isOramaIntegrationOptions<T>(
  options: T,
): options is T & OramaIntegrationOptions {
  return (
    typeof options === "object" && options !== null && "collections" in options
  );
}

/** Ensure the Orama runner is registered (safe to call more than once). */
export function ensureOramaRegistered(): void {
  registerIntegration({
    id: ORAMA_INTEGRATION_ID,
    run: async (options, context) => {
      if (!isOramaIntegrationOptions(options)) {
        throw new Error("@anhur/orama: invalid integration options.");
      }
      await buildOramaIndex(options, context);
    },
  });
}

ensureOramaRegistered();

/**
 * Add an Orama index to a typed `defineConfig` integrations array.
 * `defineConfig` supplies the content tuple as contextual type information.
 */
export function orama<TContent extends readonly AnyContent[]>(
  options: NoInfer<OramaIntegrationOptions<TContent>>,
): IntegrationConfigEntry<TContent, "orama"> {
  ensureOramaRegistered();
  return createIntegrationConfigEntry<TContent, "orama">(
    ORAMA_INTEGRATION_ID,
    options,
  );
}

/**
 * Create a runnable entry for scripts and lower-level APIs.
 * In `defineConfig`, prefer the typed {@link orama} factory.
 */
export function createOramaIntegration(
  options: OramaIntegrationOptions,
): { id: "orama" } & OramaIntegrationOptions {
  ensureOramaRegistered();
  return { id: ORAMA_INTEGRATION_ID, ...options };
}
