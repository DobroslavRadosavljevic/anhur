import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Layer } from "effect";
import { Collector } from "./collector.service";
import { ConfigLoader } from "./config-loader.service";
import { Engine } from "./engine.service";
import { FieldCache } from "./field-cache.service";
import { OutputWriter } from "./output.service";
import { Watcher } from "./watcher.service";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** Every Anhur engine service on Node. One instance per session. */
export const AnhurLive = Watcher.layer.pipe(
  Layer.provideMerge(Engine.layer),
  Layer.provideMerge(Collector.layer),
  Layer.provideMerge(
    Layer.mergeAll(ConfigLoader.layer, OutputWriter.layer, FieldCache.layer),
  ),
  Layer.provideMerge(platform),
);
