import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  GENERATOR_VERSION,
  generateFixture,
  type FixtureSummary,
} from "./generate";
import {
  StepOutputSchema,
  type Stage,
  type StepOutput,
  type StepRun,
} from "./step-output";

/** `fixture.json` of a generated project. */
const FixtureFileSchema = z.object({
  generatorVersion: z.number(),
  summary: z.object({
    documents: z.number(),
    posts: z.number(),
    pages: z.number(),
    products: z.number(),
    authors: z.number(),
    images: z.number(),
  }),
});

/** One row of the table: the time of every run of one scenario. */
type ScenarioReport = {
  readonly scenario: string;
  readonly runs: number;
  readonly medianMs: number;
  readonly minMs: number;
  /** Every run, in the order the runs happened. */
  readonly ms: readonly number[];
  /** Stages of the median run. Empty when the build reports no stages. */
  readonly stages: readonly Stage[];
};

/** Peak memory (`maxRSS`) of the processes of one scenario. */
type MemoryReport = {
  readonly measure: string;
  readonly runs: number;
  readonly medianMb: number;
  /** One number for each process. */
  readonly mb: readonly number[];
};

/** Result of every scenario for one project size. */
type SizeReport = {
  readonly size: number;
  readonly runtime: string;
  readonly fixture: FixtureSummary;
  readonly scenarios: readonly ScenarioReport[];
  readonly memory: readonly MemoryReport[];
};

/** A step of `step.ts`. */
type Step = "build" | "check" | "session";

/** One child process: what it printed and its time from start to exit. */
type StepResult = {
  readonly output: StepOutput;
  readonly processMs: number;
};

/** The runs of one scenario that starts a new process for each run. */
type ProcessRuns = {
  /** `build()` or `check()`, timed in the child process. */
  readonly inside: readonly StepRun[];
  /** The child process from start to exit, timed here. */
  readonly processMs: readonly number[];
  readonly peakRssMb: readonly number[];
};

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STEP_FILE = path.join(APP_DIR, "src", "step.ts");
const TMP_DIR = path.join(APP_DIR, ".tmp");
const DEFAULT_SIZES = [1000, 5000];
/** The session scenarios edit the first posts, so a project needs a few. */
const MIN_SIZE = 20;
/** Runs of every scenario that starts a new process (`--runs`). */
const DEFAULT_RUNS = 3;
/** Runs of every scenario of the long-lived session. */
const SESSION_RUNS = 5;
/**
 * Anhur does not trust the file times of a file that changed in the 2.5
 * seconds before it was read. A checkout is older than that when a build
 * starts, so touched files get a time this far in the past.
 */
const FILE_AGE_MS = 60_000;
const RUNTIME =
  process.versions.bun === undefined
    ? `node ${process.versions.node}`
    : `bun ${process.versions.bun}`;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}

function timeReport(
  scenario: string,
  runs: readonly StepRun[],
): ScenarioReport {
  const ms = runs.map((run) => round(run.ms));
  const sorted = [...runs].sort((a, b) => a.ms - b.ms);
  const stages = sorted[Math.floor((sorted.length - 1) / 2)]?.stages ?? [];
  return {
    scenario,
    runs: runs.length,
    medianMs: round(median(ms)),
    minMs: Math.min(...ms),
    ms,
    stages: stages.map((stage) => ({ ...stage, ms: round(stage.ms) })),
  };
}

function memoryReport(measure: string, mb: readonly number[]): MemoryReport {
  return { measure, runs: mb.length, medianMb: Math.round(median(mb)), mb };
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
}

function formatRuns(runs: number): string {
  return runs === 1 ? "1 run" : `${runs} runs`;
}

/** `discover 3 · validate 9 · …`: the stages that took a millisecond or more. */
function stageLine(stages: readonly Stage[]): string {
  return stages
    .filter((stage) => stage.ms >= 1)
    .map((stage) => `${stage.stage} ${stage.ms.toFixed(0)}`)
    .join(" · ");
}

function printScenario(report: ScenarioReport): void {
  const stages = stageLine(report.stages);
  process.stderr.write(
    `  ${report.scenario}: ${formatMs(report.medianMs)} (min ${formatMs(report.minMs)}, ${formatRuns(report.runs)})${stages === "" ? "" : `  (${stages})`}\n`,
  );
}

function printMemory(report: MemoryReport): void {
  process.stderr.write(
    `  ${report.measure}: ${report.medianMb} MB (${formatRuns(report.runs)})\n`,
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reuse the generated project of an earlier run (same size and generator
 * version = same content).
 */
async function prepareFixture(
  dir: string,
  size: number,
): Promise<FixtureSummary> {
  const fixtureFile = path.join(dir, "fixture.json");
  if (await exists(fixtureFile)) {
    const stored = FixtureFileSchema.safeParse(
      JSON.parse(await readFile(fixtureFile, "utf8")),
    );
    if (stored.success && stored.data.generatorVersion === GENERATOR_VERSION) {
      return stored.data.summary;
    }
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const summary = await generateFixture(dir, size);
  await writeFile(
    fixtureFile,
    JSON.stringify({ generatorVersion: GENERATOR_VERSION, summary }),
  );
  return summary;
}

/** The files a checkout writes: the config and everything in `content/`. */
async function projectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(dir, "content"), {
    recursive: true,
    withFileTypes: true,
  });
  return [
    path.join(dir, "anhur.config.ts"),
    ...entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name)),
  ];
}

/**
 * Give every project file a new modification time, as a new checkout does.
 * The content stays the same.
 */
async function touchProject(dir: string): Promise<void> {
  const time = new Date(Date.now() - FILE_AGE_MS);
  const files = await projectFiles(dir);
  for (let start = 0; start < files.length; start += 64) {
    await Promise.all(
      files.slice(start, start + 64).map((file) => utimes(file, time, time)),
    );
  }
}

/** Run one step of `step.ts` in a new process of the runtime of this one. */
function runStep(step: Step, dir: string, runs: number): StepResult {
  const start = performance.now();
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, STEP_FILE, step, dir, String(runs)],
    {
      cwd: APP_DIR,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const processMs = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`The step "${step}" failed in ${dir}.`);
  }
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return { output: StepOutputSchema.parse(JSON.parse(line)), processMs };
}

/** Run `step` in a new process `runs` times. `prepare` runs before each one. */
async function processRuns(
  step: Step,
  dir: string,
  runs: number,
  prepare: () => Promise<void>,
): Promise<ProcessRuns> {
  const inside: StepRun[] = [];
  const processMs: number[] = [];
  const peakRssMb: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    await prepare();
    const result = runStep(step, dir, 1);
    inside.push(...result.output.scenarios.flatMap((entry) => entry.runs));
    processMs.push(result.processMs);
    peakRssMb.push(result.output.peakRssMb);
  }
  return { inside, processMs, peakRssMb };
}

function processReports(
  scenario: string,
  processScenario: string,
  runs: ProcessRuns,
): ScenarioReport[] {
  return [
    timeReport(scenario, runs.inside),
    timeReport(
      processScenario,
      runs.processMs.map((ms) => ({ ms, stages: [] })),
    ),
  ];
}

async function runSize(size: number, runs: number): Promise<SizeReport> {
  const dir = path.join(TMP_DIR, `n${size}`);
  const fixture = await prepareFixture(dir, size);
  await copyFile(
    path.join(APP_DIR, "fixture", "anhur.config.ts"),
    path.join(dir, "anhur.config.ts"),
  );
  await rm(path.join(dir, "content", "posts", "en", "bench-added.mdx"), {
    force: true,
  });
  await touchProject(dir);
  const ready = async () => {};
  const scenarios: ScenarioReport[] = [];
  const record = (reports: readonly ScenarioReport[]) => {
    for (const report of reports) {
      scenarios.push(report);
      printScenario(report);
    }
  };

  // Cold: no output, no caches. Every run is a new process.
  const cold = await processRuns("build", dir, runs, () =>
    rm(path.join(dir, ".anhur"), { recursive: true, force: true }),
  );
  record(processReports("cold build", "cold build, whole process", cold));

  // One long-lived session that starts with the caches of the cold build.
  const session = runStep("session", dir, SESSION_RUNS);
  record(
    session.output.scenarios.map((entry) =>
      timeReport(entry.scenario, entry.runs),
    ),
  );

  // New process, warm caches, no file changed.
  const warm = await processRuns("build", dir, runs, ready);
  record(
    processReports(
      "warm start (new session)",
      "warm start, whole process",
      warm,
    ),
  );

  const checked = await processRuns("check", dir, runs, ready);
  record(
    processReports("check (new session)", "check, whole process", checked),
  );

  // New process, warm caches, new file times (a new checkout). It runs last:
  // the new file times change what a later process has to read.
  const touched = await processRuns("build", dir, runs, () =>
    touchProject(dir),
  );
  record(
    processReports(
      "new session, files touched",
      "new session, files touched, whole process",
      touched,
    ),
  );

  const memory = [
    memoryReport("peak memory, first build", cold.peakRssMb),
    memoryReport("peak memory, session (rebuilds)", [session.output.peakRssMb]),
  ];
  for (const report of memory) printMemory(report);
  return { size, runtime: RUNTIME, fixture, scenarios, memory };
}

function printTable(reports: readonly SizeReport[]): void {
  const first = reports[0];
  if (first === undefined) return;
  const header = [
    "scenario",
    "runs",
    ...reports.map((report) => `${report.size} docs`),
  ];
  const timeRows = first.scenarios.map((row, index) => [
    row.scenario,
    String(row.runs),
    ...reports.map((report) => {
      const cell = report.scenarios[index];
      return cell === undefined
        ? "-"
        : `${formatMs(cell.medianMs)} (${formatMs(cell.minMs)})`;
    }),
  ]);
  const memoryRows = first.memory.map((row, index) => [
    row.measure,
    String(row.runs),
    ...reports.map((report) => {
      const cell = report.memory[index];
      return cell === undefined ? "-" : `${cell.medianMb} MB`;
    }),
  ]);
  const rows = [...timeRows, ...memoryRows];
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const output = [
    `${RUNTIME}. Every number is the median of its runs. Times also show the fastest run in brackets.`,
    "",
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ];
  process.stdout.write(`${output.join("\n")}\n`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sizesArgument(): number[] {
  const sizes = (argument("--sizes") ?? DEFAULT_SIZES.join(","))
    .split(",")
    .map((value) => Number(value.trim()));
  if (sizes.some((size) => !Number.isInteger(size) || size < MIN_SIZE)) {
    throw new Error(`--sizes takes whole numbers of ${MIN_SIZE} or more.`);
  }
  return sizes;
}

function runsArgument(): number {
  const runs = Number(argument("--runs") ?? DEFAULT_RUNS);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs takes a whole number of 1 or more.");
  }
  return runs;
}

/**
 * `bun src/run.ts [--sizes 1000,5000] [--runs 3] [--json file]`. This
 * process only prepares the project and starts `step.ts`: every build runs
 * in a child process, so no size and no cold run warms up the next one.
 */
async function main(): Promise<void> {
  const sizes = sizesArgument();
  const runs = runsArgument();
  const reports: SizeReport[] = [];
  for (const size of sizes) {
    process.stderr.write(`${size} documents\n`);
    reports.push(await runSize(size, runs));
  }
  printTable(reports);
  const json = argument("--json");
  if (json !== undefined) {
    await mkdir(path.dirname(path.resolve(json)), { recursive: true });
    await writeFile(json, `${JSON.stringify(reports, null, 2)}\n`);
  }
}

await main();
