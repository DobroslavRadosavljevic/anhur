import { spawnSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  check,
  createAnhur,
  type AnhurSession,
  type BuildResult,
} from "@anhur/core/build";
import { z } from "zod";
import { generateFixture, type FixtureSummary } from "./generate";

const FixtureSummarySchema = z.object({
  documents: z.number(),
  posts: z.number(),
  pages: z.number(),
  products: z.number(),
  authors: z.number(),
  images: z.number(),
});

/** One timed step of a benchmark run. */
const TimingSchema = z.object({ scenario: z.string(), ms: z.number() });
type Timing = z.infer<typeof TimingSchema>;

/** Result of every scenario for one project size. */
const SizeReportSchema = z.object({
  size: z.number(),
  fixture: FixtureSummarySchema,
  timings: z.array(TimingSchema),
  peakRssMb: z.number(),
});
type SizeReport = z.infer<typeof SizeReportSchema>;

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TMP_DIR = path.join(APP_DIR, ".tmp");
const DEFAULT_SIZES = [1000, 5000];
const REPEAT = 3;

/** `discover 3 · validate 9 · …`: the stages of a build that took a millisecond or more. */
function stageLine(result: BuildResult): string {
  return result.timings
    .filter((timing) => timing.ms >= 1)
    .map((timing) => `${timing.stage} ${timing.ms.toFixed(0)}`)
    .join(" · ");
}

/** One build with its duration and stages. */
type Run = {
  readonly ms: number;
  readonly stages: string;
};

async function timedBuild(session: AnhurSession): Promise<Run> {
  const start = performance.now();
  const result = await session.build();
  return { ms: performance.now() - start, stages: stageLine(result) };
}

function medianRun(runs: readonly Run[]): Run {
  const sorted = [...runs].sort((a, b) => a.ms - b.ms);
  return sorted[Math.floor(sorted.length / 2)] ?? { ms: 0, stages: "" };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Reuse the generated project of an earlier run (same size = same content). */
async function prepareFixture(
  dir: string,
  size: number,
): Promise<FixtureSummary> {
  const summaryFile = path.join(dir, "fixture.json");
  if (await exists(summaryFile)) {
    const summary = FixtureSummarySchema.parse(
      JSON.parse(await readFile(summaryFile, "utf8")),
    );
    return summary;
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const summary = await generateFixture(dir, size);
  await writeFile(summaryFile, JSON.stringify(summary));
  return summary;
}

async function runSize(size: number): Promise<SizeReport> {
  const dir = path.join(TMP_DIR, `n${size}`);
  const fixture = await prepareFixture(dir, size);
  await copyFile(
    path.join(APP_DIR, "fixture", "anhur.config.ts"),
    path.join(dir, "anhur.config.ts"),
  );
  await rm(path.join(dir, ".anhur"), { recursive: true, force: true });
  await rm(path.join(dir, "content", "posts", "en", "bench-added.mdx"), {
    force: true,
  });
  const timings: Timing[] = [];
  const record = (scenario: string, run: Run) => {
    timings.push({ scenario, ms: run.ms });
    process.stderr.write(
      `  ${scenario}: ${run.ms.toFixed(0)} ms${run.stages === "" ? "" : `  (${run.stages})`}\n`,
    );
  };

  // Cold: no output, no caches.
  const session = createAnhur({ rootDir: dir, mode: "build" });
  record("cold build", await timedBuild(session));

  // Same session, nothing changed.
  const noop: Run[] = [];
  for (let round = 0; round < REPEAT; round += 1) {
    noop.push(await timedBuild(session));
  }
  record("rebuild, no change", medianRun(noop));

  // Same session, one post edited.
  const edits: Run[] = [];
  for (let round = 0; round < REPEAT; round += 1) {
    const file = path.join(
      dir,
      "content",
      "posts",
      "en",
      `post-${round * 2}.mdx`,
    );
    const original = await readFile(file, "utf8");
    await appendFile(file, `\n\nEdited in round ${round}.\n`);
    edits.push(await timedBuild(session));
    await writeFile(file, original);
    await session.build();
  }
  record("rebuild, 1 file edited", medianRun(edits));

  // Same session, one post added.
  const added = path.join(dir, "content", "posts", "en", "bench-added.mdx");
  await writeFile(
    added,
    "---\ntitle: Added\npublishedAt: 2024-01-01\ntags: [news]\nauthor: author-0\n---\n\n## Added\n\nNew post.\n",
  );
  record("rebuild, 1 file added", await timedBuild(session));
  await rm(added, { force: true });
  await session.build();
  await session.close();

  // New session (a second CI run, a dev server restart): caches are warm.
  const warm = createAnhur({ rootDir: dir, mode: "build" });
  record("warm start (new session)", await timedBuild(warm));
  await warm.close();

  const checkStart = performance.now();
  const checked = await check({ rootDir: dir });
  record("check (new session)", {
    ms: performance.now() - checkStart,
    stages: stageLine(checked),
  });

  return {
    size,
    fixture,
    timings,
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  };
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function printTable(reports: readonly SizeReport[]): void {
  const scenarios = reports[0]?.timings.map((timing) => timing.scenario) ?? [];
  const header = [
    "scenario",
    ...reports.map((report) => `${report.size} docs`),
  ];
  const rows = scenarios.map((scenario) => [
    scenario,
    ...reports.map((report) => {
      const timing = report.timings.find(
        (entry) => entry.scenario === scenario,
      );
      return timing ? formatMs(timing.ms) : "-";
    }),
  ]);
  rows.push([
    "peak memory",
    ...reports.map((report) => `${report.peakRssMb} MB`),
  ]);
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const output = [
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

/**
 * `bun src/run.ts [--sizes 1000,5000] [--json file]`. Every size runs in
 * its own process, so memory and module caches do not carry over.
 */
async function main(): Promise<void> {
  const child = argument("--child");
  if (child !== undefined) {
    const report = await runSize(Number(child));
    process.stdout.write(JSON.stringify(report));
    return;
  }
  const sizes = (argument("--sizes") ?? DEFAULT_SIZES.join(","))
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  const reports: SizeReport[] = [];
  for (const size of sizes) {
    process.stderr.write(`${size} documents\n`);
    const result = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--child",
        String(size),
      ],
      {
        cwd: APP_DIR,
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      throw new Error(`The ${size} document run failed.`);
    }
    const report = SizeReportSchema.parse(JSON.parse(result.stdout));
    reports.push(report);
  }
  printTable(reports);
  const json = argument("--json");
  if (json !== undefined) {
    await writeFile(json, `${JSON.stringify(reports, null, 2)}\n`);
  }
}

await main();
