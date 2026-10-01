import type { PluginInput } from "../plugin/types";
import type {
  AnhurConfig,
  AnyContent,
  AnyDerived,
  FolderLocalization,
} from "./types";

type ConfigBase = Omit<
  AnhurConfig,
  "content" | "views" | "localization" | "plugins"
>;

/**
 * Define the project config. Keeps the literal `content` tuple, view names
 * and locales so generated types (`GetTypeByName<typeof config, "posts">`)
 * stay exact, and types `plugins` (such as `orama()`) against the content.
 *
 * The config is validated when it is loaded (names, paths, plugins,
 * references); every problem is reported at once.
 */
export function defineConfig<
  const TContent extends readonly AnyContent[],
  const TLocales extends readonly string[],
  const TViews extends readonly AnyDerived[] = [],
  // Kept literal so plugins can carry types into generated declarations
  // (typed search stores). The union below keeps `doc` in plugin callbacks
  // inferred from `content` while TPlugins itself is still being inferred.
  const TPlugins extends readonly PluginInput<NoInfer<TContent>>[] =
    readonly [],
>(
  config: ConfigBase & {
    readonly content: TContent;
    readonly views?: TViews;
    readonly localization: FolderLocalization<TLocales>;
    readonly plugins?: TPlugins | readonly PluginInput<NoInfer<TContent>>[];
  },
): ConfigBase & {
  readonly content: TContent;
  readonly views?: TViews;
  readonly localization: FolderLocalization<TLocales>;
  readonly plugins?: TPlugins;
};
export function defineConfig<
  const TContent extends readonly AnyContent[],
  const TViews extends readonly AnyDerived[] = [],
  // Kept literal so plugins can carry types into generated declarations
  // (typed search stores). The union below keeps `doc` in plugin callbacks
  // inferred from `content` while TPlugins itself is still being inferred.
  const TPlugins extends readonly PluginInput<NoInfer<TContent>>[] =
    readonly [],
>(
  config: ConfigBase & {
    readonly content: TContent;
    readonly views?: TViews;
    readonly localization?: undefined;
    readonly plugins?: TPlugins | readonly PluginInput<NoInfer<TContent>>[];
  },
): ConfigBase & {
  readonly content: TContent;
  readonly views?: TViews;
  readonly plugins?: TPlugins;
};
export function defineConfig(config: AnhurConfig): AnhurConfig {
  return config;
}
