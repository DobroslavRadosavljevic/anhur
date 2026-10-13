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
import type { BuildResult, StageTiming } from "../engine/result";
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
    Flag.withDescription(
      "Print a JSON report (watch: one line of JSON per build)",
    ),
    Flag.withDefault(false),
  ),
  timings: Flag.Boolean("timings").pipe(
    Flag.withDescription("Print how long each stage of the build took"),
    Flag.withDefault(false),
  ),
};

type CliFlags = {
  readonly root: string;
  readonly config:
    | { readonly _tag: "Some"; readonly value: string }
    | { readonly _tag: "None" };
  readonly json: boolean;
  readonly timings: boolean;
};

function configOf(options: CliFlags): string | undefined {
  return options.config._tag === "Some" ? options.config.value : undefined;
}

function stageLine(timings: readonly StageTiming[]): string {
  return timings
    .map((timing) => `${timing.stage} ${Math.round(timing.ms)} ms`)
    .join(" · ");
}

/** The stage times of a failed build: the last stage is the one that failed. */
function failedStageLine(error: AnhurBuildError): string | undefined {
  return error.timings.length === 0
    ? undefined
    : `anhur:   failed in ${error.timings.at(-1)?.stage ?? "?"} · ${stageLine(error.timings)}`;
}

function report(kind: string, result: BuildResult, timings: boolean): string {
  const relative =
    path.relative(process.cwd(), result.outputDir) || result.outputDir;
  const lines = [
    `anhur: ${kind} ${result.documentCount} document(s) → ${relative}${result.dryRun ? " (dry run, nothing written)" : ` (${result.written.length} written, ${result.removed.length} removed)`}`,
    ...result.messages.map((message) => `anhur:   ${message}`),
  ];
  if (timings) {
    const { unchanged, compared, validated } = result.reuse;
    lines.push(
      `anhur:   ${stageLine(result.timings)}`,
      `anhur:   documents: ${unchanged} unchanged · ${compared} compared by content · ${validated} validated`,
      ...result.notStored.map(
        (entry) =>
          `anhur:   "${entry.source}" is validated in every new session: ${entry.reason}`,
      ),
    );
  }
  if (result.warnings.length > 0) {
    lines.push(
      formatDiagnostics(result.warnings, { relativeTo: result.projectDir }),
    );
  }
  return lines.join("\n");
}

/**
 * The JSON report of one build; `indent: 0` puts it on one line. A failed
 * build has no result; `failedTimings` are the stages it ran.
 */
function jsonReport(
  result: BuildResult | undefined,
  diagnostics: readonly Diagnostic[],
  indent = 2,
  failedTimings?: readonly StageTiming[],
): string {
  return JSON.stringify(
    {
      ok: result !== undefined,
      outputDir: result?.outputDir,
      documents: result?.documentCount,
      written: result?.written,
      removed: result?.removed,
      timings: result?.timings ?? failedTimings,
      reuse: result?.reuse,
      notStored: result?.notStored,
      diagnostics: diagnostics.map(({ cause: _cause, ...rest }) => rest),
    },
    null,
    indent,
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
        : report(kind, exit.success, options.timings),
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
  const failedTimings =
    failure instanceof AnhurBuildError ? failure.timings : [];
  // The JSON report is the command's output, so it goes to stdout even on failure.
  if (options.json) {
    yield* Console.log(jsonReport(undefined, diagnostics, 2, failedTimings));
  } else {
    yield* Console.error(
      failure instanceof AnhurBuildError
        ? failure.message
        : (diagnostics[0]?.message ?? String(failure)),
    );
    const stages =
      options.timings && failure instanceof AnhurBuildError
        ? failedStageLine(failure)
        : undefined;
    if (stages !== undefined) yield* Console.error(stages);
  }
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
    // With --json, stdout has one line of JSON per build and nothing else.
    if (!options.json) yield* Console.log(`anhur: watching ${rootDir}`);
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          watch(
            { rootDir, configPath: configOf(options), mode: "dev" },
            {
              onBuild: (result) => {
                console.log(
                  options.json
                    ? jsonReport(result, result.warnings, 0)
                    : report("rebuilt", result, options.timings),
                );
              },
              onError: (error) => {
                if (options.json) {
                  console.log(
                    jsonReport(undefined, error.diagnostics, 0, error.timings),
                  );
                  return;
                }
                console.error(error.message);
                const stages = options.timings
                  ? failedStageLine(error)
                  : undefined;
                if (stages !== undefined) console.error(stages);
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
