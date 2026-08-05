import { Layer } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Builder } from "../services/builder";
import { ConfigLoader } from "../services/config-loader";
import { ContentCollector } from "../services/content-collector";
import { Generator } from "../services/generator";
import { Watcher } from "../services/watcher";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** FileSystem-backed config / collect / generate services. */
const contentStack = Layer.mergeAll(
  ConfigLoader.layer,
  ContentCollector.layer,
  Generator.layer,
).pipe(Layer.provide(platform));

const builderStack = Builder.layer.pipe(
  Layer.provide(contentStack),
  Layer.provide(platform),
);

const watcherStack = Watcher.layer.pipe(
  Layer.provide(builderStack),
  Layer.provide(contentStack),
  Layer.provide(platform),
);

/**
 * Full Node live layer: platform FileSystem + Path + all Anhur services.
 */
export const layer: Layer.Layer<
  ConfigLoader | ContentCollector | Generator | Builder | Watcher
> = Layer.mergeAll(contentStack, builderStack, watcherStack);
