import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  build,
  check,
  createAnhur,
  type AnhurSession,
  type BuildResult,
} from "@anhur/core/build";
import {
  BuildStagesSchema,
  type StepOutput,
  type StepRun,
  type StepScenario,
} from "./step-output";

async function timed(run: () => Promise<BuildResult>): Promise<StepRun> {
  const start = performance.now();
  const result = await run();
  const ms = performance.now() - start;
  return { ms, stages: BuildStagesSchema.parse(result).timings ?? [] };
}

function postFile(dir: string, round: number): string {
  return path.join(dir, "content", "posts", "en", `post-${round * 2}.mdx`);
}

/**
 * Change `file`, time one build, then put the old content and the old file
 * times back and build again, so the next run starts from the same state.
 */
async function timedEdit(
  session: AnhurSession,
  file: string,
  edit: (content: string) => string,
): Promise<StepRun> {
  const before = await stat(file);
  const original = await readFile(file, "utf8");
  const edited = edit(original);
  if (edited === original) throw new Error(`The edit did not change ${file}.`);
  await writeFile(file, edited);
  const run = await timed(() => session.build());
  await writeFile(file, original);
  await utimes(file, before.atime, before.mtime);
  await session.build();
  return run;
}

async function timedAdd(session: AnhurSession, dir: string): Promise<StepRun> {
  const added = path.join(dir, "content", "posts", "en", "bench-added.mdx");
  await writeFile(
    added,
    "---\ntitle: Added\npublishedAt: 2024-01-01\ntags: [news]\nauthor: author-0\n---\n\n## Added\n\nNew post.\n",
  );
  const run = await timed(() => session.build());
  await rm(added, { force: true });
  await session.build();
  return run;
}

/** Every scenario of one long-lived session, `runs` times each. */
async function sessionScenarios(
  dir: string,
  runs: number,
): Promise<StepScenario[]> {
  const session = createAnhur({ rootDir: dir, mode: "build" });
  try {
    // The first build loads the caches of the last process. It is not reported.
    await session.build();
    const noChange: StepRun[] = [];
    const bodyEdits: StepRun[] = [];
    const titleEdits: StepRun[] = [];
    const additions: StepRun[] = [];
    for (let round = 0; round < runs; round += 1) {
      noChange.push(await timed(() => session.build()));
    }
    for (let round = 0; round < runs; round += 1) {
      bodyEdits.push(
        await timedEdit(
          session,
          postFile(dir, round),
          (content) => `${content}\n\nEdited in round ${round}.\n`,
        ),
      );
    }
    for (let round = 0; round < runs; round += 1) {
      titleEdits.push(
        await timedEdit(session, postFile(dir, round), (content) =>
          content.replace(/^title: .*$/m, (line) => `${line} edited`),
        ),
      );
    }
    for (let round = 0; round < runs; round += 1) {
      additions.push(await timedAdd(session, dir));
    }
    return [
      { scenario: "rebuild, no change", runs: noChange },
      { scenario: "rebuild, 1 file edited", runs: bodyEdits },
      { scenario: "rebuild, 1 title edited", runs: titleEdits },
      { scenario: "rebuild, 1 file added", runs: additions },
    ];
  } finally {
    await session.close();
  }
}

async function scenariosOf(
  step: string,
  dir: string,
  runs: number,
): Promise<StepScenario[]> {
  switch (step) {
    case "build": {
      const run = await timed(() => build({ rootDir: dir, mode: "build" }));
      return [{ scenario: step, runs: [run] }];
    }
    case "check": {
      const run = await timed(() => check({ rootDir: dir }));
      return [{ scenario: step, runs: [run] }];
    }
    case "session": {
      return sessionScenarios(dir, runs);
    }
    default: {
      throw new Error(`Unknown step "${step}".`);
    }
  }
}

/**
 * `step.ts <build | check | session> <project folder> [runs]`: one measured
 * step of `run.ts`, in a process of its own. It imports only what a build
 * needs, so the time of the whole process is close to that of `anhur build`.
 * It prints one line of JSON.
 */
async function main(): Promise<void> {
  const [step = "", dir = "", runs = "1"] = process.argv.slice(2);
  const scenarios = await scenariosOf(step, path.resolve(dir), Number(runs));
  const output: StepOutput = {
    scenarios,
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();
