#!/usr/bin/env bun
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { run } from "./cli/app";

run.pipe(NodeRuntime.runMain);
