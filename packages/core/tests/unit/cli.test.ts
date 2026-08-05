import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { TestConsole } from "effect/testing";
import { describe, expect, it } from "vitest";
import { CliOutput, Command } from "effect/unstable/cli";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { cli } from "../../src/cli/app";
import { packageVersion } from "../../src/package-version";
import { Builder } from "../../src/services/builder";
import { Watcher } from "../../src/services/watcher";
import packageJson from "../../package.json" with { type: "json" };

const unused = (label: string) => Effect.die(`${label} unused in help test`);

const TestLayer = Layer.mergeAll(
  TestConsole.layer,
  FileSystem.layerNoop({}),
  Path.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => unused("ChildProcessSpawner")),
  ),
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      display: () => Effect.void,
      readInput: Effect.die("Terminal.readInput unused"),
      readLine: Effect.succeed(""),
    }),
  ),
  Layer.succeed(Builder, {
    build: () => unused("Builder"),
  }),
  Layer.succeed(Watcher, {
    start: () => unused("Watcher"),
  }),
);

describe("Effect CLI", () => {
  it("reads version from package.json", () => {
    expect(packageVersion).toBe(packageJson.version);
  });

  it("renders root help via Command.runWith", async () => {
    const text = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Command.runWith(cli, { version: packageVersion })(["--help"]);
        const lines = yield* TestConsole.logLines;
        return lines.join("\n");
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(text).toMatch(/build/);
    expect(text).toMatch(/watch/);
    expect(text).toMatch(/anhur/);
  });
});
