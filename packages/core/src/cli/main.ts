#!/usr/bin/env node
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import { Console, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import path from "node:path";
import {
  AnhurBuildError,
  errorDiagnostic,
  formatDiagnostics,
  type Diagnostic,
} from "../diagnostics";
import { check, build, watch } from "../build/runtime";
import type { BuildResult } from "../engine/result";
import { packageVersion } from "./package-version";

const flags = {
  root: Flag.Directory("root", { mustExist: true }).pipe(
    Flag.withDescription("Folder to look for the config in"),
    Flag.withDefault("."),
  ),
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "Config file, relative to --root (default: anhur.config.{ts,mts,js,mjs})",
    ),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print a JSON report"),
    Flag.withDefault(false),
  ),
};

type CliFlags = {
  readonly root: string;
  readonly config:
    | { readonly _tag: "Some"; readonly value: string }
    | { readonly _tag: "None" };
  readonly json: boolean;
};

function configOf(options: CliFlags): string | undefined {
  return options.config._tag === "Some" ? options.config.value : undefined;
}

function report(kind: string, result: BuildResult): string {
  const relative =
    path.relative(process.cwd(), result.outputDir) || result.outputDir;
  const lines = [
    `anhur: ${kind} ${result.documentCount} document(s) → ${relative}${result.dryRun ? " (dry run, nothing written)" : ` (${result.written.length} written, ${result.removed.length} removed)`}`,
    ...result.messages.map((message) => `anhur:   ${message}`),
  ];
  if (result.warnings.length > 0) {
    lines.push(
      formatDiagnostics(result.warnings, { relativeTo: result.projectDir }),
    );
  }
  return lines.join("\n");
}

function jsonReport(
  result: BuildResult | undefined,
  diagnostics: readonly Diagnostic[],
): string {
  return JSON.stringify(
    {
      ok: result !== undefined,
      outputDir: result?.outputDir,
      documents: result?.documentCount,
      written: result?.written,
      removed: result?.removed,
      diagnostics: diagnostics.map(({ cause: _cause, ...rest }) => rest),
    },
    null,
    2,
  );
}

const runOnce = Effect.fn("cli.runOnce")(function* (
  kind: "built" | "checked",
  options: CliFlags,
) {
  const rootDir = path.resolve(options.root);
  const exit = yield* Effect.tryPromise({
    try: () =>
      (kind === "built" ? build : check)({
        rootDir,
        configPath: configOf(options),
        mode: "build",
      }),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (exit._tag === "Success") {
    yield* Console.log(
      options.json
        ? jsonReport(exit.success, exit.success.warnings)
        : report(kind, exit.success),
    );
    return;
  }
  const failure = exit.failure;
  const diagnostics: readonly Diagnostic[] =
    failure instanceof AnhurBuildError
      ? failure.diagnostics
      : [
          errorDiagnostic(
            "internal",
            `Unexpected error: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
            { hint: "This is a bug in Anhur or a plugin." },
          ),
        ];
  // The JSON report is the command's output, so it goes to stdout even on failure.
  if (options.json) yield* Console.log(jsonReport(undefined, diagnostics));
  else
    yield* Console.error(
      failure instanceof AnhurBuildError
        ? failure.message
        : (diagnostics[0]?.message ?? String(failure)),
    );
  process.exitCode = 1;
});

const buildCommand = Command.make("build", flags, (options) =>
  runOnce("built", options),
).pipe(
  Command.withDescription("Validate content and write the generated modules"),
);

const checkCommand = Command.make("check", flags, (options) =>
  runOnce("checked", options),
).pipe(
  Command.withDescription("Validate content without writing anything (for CI)"),
);

const watchCommand = Command.make(
  "watch",
  flags,
  Effect.fn("cli.watch")(function* (options: CliFlags) {
    const rootDir = path.resolve(options.root);
    yield* Console.log(`anhur: watching ${rootDir}`);
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          watch(
            { rootDir, configPath: configOf(options), mode: "dev" },
            {
              onBuild: (result) => {
                console.log(report("rebuilt", result));
              },
              onError: (error) => {
                console.error(error.message);
              },
            },
          ),
        catch: (cause) => cause,
      }).pipe(Effect.orDie),
      (controller) =>
        Effect.tryPromise({
          try: () => controller.close(),
          catch: (cause) => cause,
        }).pipe(
          Effect.ignore({ log: "Warn", message: "Closing the watcher failed" }),
        ),
    );
    yield* Effect.never;
  }, Effect.scoped),
).pipe(Command.withDescription("Rebuild whenever content or config changes"));

const anhur = Command.make("anhur").pipe(
  Command.withDescription(
    "Typed content from Markdown, MDX, YAML and JSON files",
  ),
  Command.withSubcommands([buildCommand, checkCommand, watchCommand]),
);

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const cliLayer = Layer.mergeAll(
  NodeStdio.layer,
  NodeTerminal.layer,
  NodeChildProcessSpawner.layer.pipe(Layer.provide(platform)),
).pipe(Layer.provideMerge(platform));

Command.run(anhur, { version: packageVersion }).pipe(
  Effect.provide(cliLayer),
  NodeRuntime.runMain,
);
