import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  build,
  createAnhur,
  isAnhurBuildError,
  type Diagnostic,
} from "../../src/build";
import { Collector } from "../../src/engine/collector.service";
import { ConfigLoader } from "../../src/engine/config-loader.service";
import { FieldCache } from "../../src/engine/field-cache.service";
import { poolWork, validateInWorkers } from "../../src/engine/validation-pool";
import {
  fromWireDiagnostic,
  toWireDiagnostic,
  type WireFile,
  type WorkerSetup,
} from "../../src/engine/validation-wire";
import { createProject, type TestProject } from "../fixtures/temp-project";

const projects: TestProject[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.remove();
});

const DOCUMENTS = 150;

/** A project with enough documents for worker threads (`workers: 2` forces them). */
async function project(
  config: string,
  extra: { readonly [file: string]: string } = {},
): Promise<TestProject> {
  const files: { [file: string]: string } = { "anhur.config.ts": config };
  for (let index = 0; index < DOCUMENTS; index += 1) {
    files[`notes/n${String(index).padStart(4, "0")}.md`] =
      `---\ntitle: N${index}\n---\n`;
  }
  const created = await createProject({ ...files, ...extra });
  projects.push(created);
  return created;
}

const HEAD = `
import { appendFileSync } from "node:fs";
import { isMainThread, threadId } from "node:worker_threads";
import { defineCollection, defineConfig, schema as s } from "@anhur/core";
import { defineField } from "@anhur/core/plugin";
`;

/** A config with one compiled field; `compile` is the source of its function. */
function config(compile: string, options: string, before = ""): string {
  return `${HEAD}
${before}
const where = defineField(s.any(), {
  kind: "where",
  whenAbsent: "compile",
  cache: { version: "1", key: () => "k" },
  compile: ${compile},
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({ title: s.string(), thread: where }),
});
export default defineConfig({ content: [notes], ${options} });
`;
}

/** The thread every document was compiled in (`0`: the main thread). */
async function threads(dir: TestProject): Promise<Set<number>> {
  const list = await dir.read(".anhur/generated/allNotes.js");
  return new Set(
    [...list.matchAll(/"thread":(\d+)/g)].map((match) => Number(match[1])),
  );
}

async function titles(dir: TestProject): Promise<number> {
  const list = await dir.read(".anhur/generated/allNotes.js");
  return new Set([...list.matchAll(/"title":"N(\d+)"/g)].map((m) => m[1])).size;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("worker threads that cannot do the work", () => {
  // Failure: a config that only loads in the main thread ends the build,
  // loses documents, or warns once per worker.
  it("fall back to the main thread with one warning when the config throws in a worker", async () => {
    const dir = await project(
      config(
        "() => threadId",
        "workers: 2",
        `if (!isMainThread) throw new Error("no workers here");`,
      ),
    );
    const result = await build({ rootDir: dir.dir });
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      expect.stringMatching(
        /^Worker threads could not be used for every document \(.*no workers here.*\); the rest was compiled in the main thread\.$/s,
      ),
    ]);
    expect(result.documentCount).toBe(DOCUMENTS);
    expect(await titles(dir)).toBe(DOCUMENTS);
    expect(await threads(dir)).toEqual(new Set([0]));
  });

  // Failure: the config file changes after the main thread read it. A
  // worker would validate with other schemas than the build has.
  it("validate everything in the main thread when a worker loads another config", async () => {
    const dir = await project("");
    await dir.write(
      "anhur.config.ts",
      config(
        "() => threadId",
        "workers: 2",
        `if (isMainThread) appendFileSync(${JSON.stringify(dir.path("anhur.config.ts"))}, "\\n// edited while the build runs\\n");`,
      ),
    );
    const result = await build({ rootDir: dir.dir });
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining(
        "the config loaded in a worker is not the one being built",
      ),
    ]);
    expect(await titles(dir)).toBe(DOCUMENTS);
    expect(await threads(dir)).toEqual(new Set([0]));
  });

  // Failure: a value `postMessage` cannot copy kills the reply, and the
  // warning gives no reason ("()" on Node).
  it("say why when a result cannot be sent to the main thread", async () => {
    const dir = await project(
      config(
        `(_value, context) =>
    context.document.id === "n0077" ? new Proxy({ here: threadId }, {}) : threadId`,
        "workers: 2",
      ),
    );
    const result = await build({ rootDir: dir.dir });
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      expect.stringMatching(/\(a worker could not send its results: \S.*\);/s),
    ]);
    expect(await titles(dir)).toBe(DOCUMENTS);
  });
});

const RICH = (workers: string) => `${HEAD}
class CompileProblem extends Error {
  code = "E_COMPILE";
  line = 12;
  constructor(message, options) {
    super(message, options);
    this.name = "CompileProblem";
  }
}
const rich = defineField(s.any(), {
  kind: "rich",
  whenAbsent: "compile",
  cache: { version: "1", key: () => "k" },
  compile: (_value, context) => {
    const id = context.document.id;
    appendFileSync(${JSON.stringify("__LOG__")}, (isMainThread ? "main" : "worker") + "\\n");
    if (id === "broken") {
      throw new CompileProblem("cannot compile " + id, {
        cause: new TypeError("the root cause"),
      });
    }
    context.warn("first warning of " + id);
    context.warn("second warning of " + id);
    return {
      negativeZero: -0,
      nothing: undefined,
      when: new Date(86_400_000),
      lookup: new Map([["key", new Set([1, -0, "two"])]]),
      big: 10n ** 30n,
      list: [1, undefined, { deep: new Date(0) }],
    };
  },
});
const notes = defineCollection({
  name: "notes",
  directory: "notes",
  include: "*.md",
  schema: s.object({
    title: s.string(),
    rich,
    nested: s.object({ count: s.number() }).optional(),
  }),
  transform: (doc) => ({
    ...doc,
    shout: doc.title.toUpperCase(),
    keepsNegativeZero: Object.is(doc.rich.negativeZero, -0),
    keepsUndefined: "nothing" in doc.rich,
    keepsDate: doc.rich.when instanceof Date,
    keepsSet: doc.rich.lookup.get("key") instanceof Set,
  }),
});
export default defineConfig({ content: [notes], workers: ${workers} });
`;

/** Every file of a folder, by its relative path. */
async function folder(root: string): Promise<{ [file: string]: string }> {
  const files: { [file: string]: string } = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(root, file).split(path.sep).join("/")] = (
      await readFile(file)
    ).toString("base64");
  }
  return files;
}

type CauseView = {
  readonly name?: string;
  readonly message?: string;
  readonly code?: string;
  readonly line?: number;
  readonly cause?: CauseView;
};

/** A cause the way a reader of a diagnostic sees it. */
function causeView(diagnostic: Diagnostic): CauseView | undefined {
  // SAFETY: the test only reads these fields, and checks each one.
  const cause = diagnostic.cause as CauseView | undefined;
  if (cause === undefined) return undefined;
  return {
    name: cause.name,
    message: cause.message,
    code: cause.code,
    line: cause.line,
    cause: cause.cause && {
      name: cause.cause.name,
      message: cause.cause.message,
    },
  };
}

describe("worker threads and the main thread", () => {
  async function rich(
    workers: string,
    extra: { readonly [file: string]: string } = {},
  ) {
    const dir = await project("", extra);
    await dir.write(
      "anhur.config.ts",
      RICH(workers).replace("__LOG__", dir.path("where.log")),
    );
    /** Paths differ between the two projects: compare without them. */
    const plain = (text: string | undefined): string | undefined =>
      text?.replaceAll(dir.dir, "<project>");
    const view = (diagnostic: Diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: plain(diagnostic.message),
      file: plain(diagnostic.file),
      source: diagnostic.source,
      fieldPath: diagnostic.fieldPath,
      hint: plain(diagnostic.hint),
      cause: causeView(diagnostic),
    });
    const where = async (): Promise<Set<string>> =>
      new Set((await dir.read("where.log")).trim().split("\n"));
    return { dir, view, where };
  }

  // Failure: a value changes on the way between threads (`-0`, `undefined`,
  // `Date`, `Map`, `Set`, `bigint`), a warning is lost or moves, or a
  // transform sees other data than in the main thread.
  it("write the same files and give the same warnings", async () => {
    const main = await rich("false");
    const pool = await rich("2");
    const fromMain = await build({ rootDir: main.dir.dir });
    const fromPool = await build({ rootDir: pool.dir.dir });

    expect(await main.where()).toEqual(new Set(["main"]));
    expect(await pool.where()).toEqual(new Set(["worker"]));
    expect(fromPool.warnings.map(pool.view)).toEqual(
      fromMain.warnings.map(main.view),
    );
    expect(fromMain.warnings).toHaveLength(DOCUMENTS * 2);
    const written = await folder(main.dir.path(".anhur/generated"));
    expect(Object.keys(written).length).toBeGreaterThan(2);
    expect(await folder(pool.dir.path(".anhur/generated"))).toEqual(written);
    const list = await main.dir.read(".anhur/generated/allNotes.js");
    expect(list).toContain('"keepsNegativeZero":true');
    expect(list).toContain('"keepsUndefined":true');
    expect(list).toContain('"keepsDate":true');
    expect(list).toContain('"keepsSet":true');
  });

  // Failure: an error from a worker differs from the same error in the
  // main thread: another order, a lost field path, or a cause without its
  // `code`, `line` and own cause.
  it("report the same errors, in the same order, with the same cause", async () => {
    const bad = {
      "notes/broken.md": "---\ntitle: Broken\n---\n",
      "notes/n0003.md": "---\ntitle: [a, b]\nnested:\n  count: nope\n---\n",
      "notes/n0140.md": '---\ntitle: "unterminated\n---\n',
    };
    const main = await rich("false", bad);
    const pool = await rich("2", bad);
    const failure = async (run: Awaited<ReturnType<typeof rich>>) => {
      const error: unknown = await build({ rootDir: run.dir.dir }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      if (!isAnhurBuildError(error)) throw new Error("the build did not fail");
      return error.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map(run.view);
    };
    const fromMain = await failure(main);
    const fromPool = await failure(pool);

    expect(await pool.where()).toEqual(new Set(["worker"]));
    expect(fromMain.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["validation-failed", "field-failed"]),
    );
    expect(fromMain.length).toBeGreaterThanOrEqual(4);
    expect(
      fromMain.find((diagnostic) => diagnostic.cause?.code === "E_COMPILE")
        ?.cause,
    ).toEqual({
      name: "CompileProblem",
      message: "cannot compile broken",
      code: "E_COMPILE",
      line: 12,
      cause: { name: "TypeError", message: "the root cause" },
    });
    expect(fromPool).toEqual(fromMain);
  });
});

describe("a cause between threads", () => {
  /** What the other thread gets: `postMessage` copies like `structuredClone`. */
  const sent = (cause: unknown): Diagnostic =>
    fromWireDiagnostic(
      structuredClone(
        toWireDiagnostic({
          code: "field-failed",
          severity: "error",
          message: "failed",
          cause,
        }),
      ),
    );

  // Failure: a part that cannot be copied (a function) makes the whole
  // message throw, so every result of the batch is lost.
  it("keeps what can be copied of an error with a function on it", () => {
    const error = Object.assign(new RangeError("out of range"), {
      code: "E_RANGE",
      retry: () => undefined,
      position: { line: 3, column: 9 },
    });
    const copy = sent(error).cause;
    expect(copy).toBeInstanceOf(Error);
    expect(copy).toMatchObject({
      name: "RangeError",
      message: "out of range",
      stack: error.stack,
      code: "E_RANGE",
      position: { line: 3, column: 9 },
    });
    expect(copy).not.toHaveProperty("retry");
  });

  // Failure: a thrown plain object arrives as the text "[object Object]".
  it("keeps thrown data as data, without the parts that cannot be copied", () => {
    expect(sent({ status: 404, at: new Date(5) }).cause).toEqual({
      status: 404,
      at: new Date(5),
    });
    expect(sent({ status: 500, retry: () => undefined }).cause).toEqual({
      status: 500,
    });
    expect(sent("only text").cause).toBe("only text");
  });

  // Failure: a cause that points at itself never ends, or overflows the stack.
  it("ends a chain of causes that goes in a circle", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    let copy = sent(first).cause;
    let depth = 0;
    while (copy instanceof Error && depth < 100) {
      copy = copy.cause;
      depth += 1;
    }
    expect(copy).toBeUndefined();
    expect(depth).toBeGreaterThan(2);
  });
});

describe("closing a session during a worker build", () => {
  // Failure: workers go on after `close()`: they compile the rest of the
  // project and write caches into a folder the caller may have removed.
  it("leaves no worker thread and starts no compile after close() resolved", async () => {
    const dir = await project("");
    const log = dir.path("activity.log");
    await dir.write(
      "anhur.config.ts",
      config(
        `async (_value, context) => {
    appendFileSync(LOG, "compile " + context.document.id + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    return threadId;
  }`,
        "workers: 2",
        // A thread that is alive writes a line every few milliseconds.
        `const LOG = ${JSON.stringify(log)};
if (!isMainThread) setInterval(() => appendFileSync(LOG, "alive " + threadId + "\\n"), 10);`,
      ),
    );
    const activity = () => readFile(log, "utf8").catch(() => "");
    const session = createAnhur({ rootDir: dir.dir });
    try {
      const built = session.build().then(
        () => "built",
        () => "stopped",
      );
      while (((await activity()).match(/^compile /gm) ?? []).length < 16) {
        await sleep(20);
      }
      await session.close();
      const atClose = await activity();
      // Long enough for a live thread to write many lines.
      await sleep(400);
      expect(atClose).toContain("alive ");
      expect(await activity()).toBe(atClose);
      expect(await built).toBe("stopped");
    } finally {
      await session.close();
    }
  });
});

describe("the worker pool", () => {
  const PoolLive = Collector.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ConfigLoader.layer, FieldCache.layer)),
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );

  /** What the collector gives the pool for the project in `rootDir`. */
  const poolInput = Effect.fnUntraced(function* (rootDir: string) {
    const loader = yield* ConfigLoader;
    const collector = yield* Collector;
    const { project: loaded } = yield* loader.load({
      rootDir,
      configPath: undefined,
      mode: "build",
    });
    const found = yield* collector.discover(loaded);
    const setup: WorkerSetup = {
      rootDir: loaded.projectDir,
      configPath: loaded.configPath,
      mode: loaded.mode,
      fingerprint: loaded.fingerprint,
      publicBase: undefined,
      assetRoots: [],
    };
    const files = found.files.map((file): WireFile => ({
      source: file.source.name,
      absPath: file.absPath,
      id: file.id,
      locale: file.locale,
      meta: file.meta,
      raw: undefined,
      hash: undefined,
      signature: undefined,
    }));
    return { setup, files };
  });

  // Failure: a compile that never gives the thread back (an endless loop)
  // makes the build wait for ever: no limit inside the worker can fire.
  effectIt.live(
    "stops a worker whose thread is blocked, fails its batch and finishes the rest",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.tryPromise(() =>
          project(
            config(
              `(_value, context) => {
    if (!isMainThread && context.document.id === "n0077") for (;;) {}
    return threadId;
  }`,
              "workers: 2",
            ),
          ),
        );
        const { setup, files } = yield* poolInput(dir.dir);
        const outcome = yield* poolWork((signal) =>
          validateInWorkers(setup, files, {
            workers: 2,
            dryRun: true,
            readAt: 0,
            signal,
            batchTimeoutMs: 2000,
          }),
        );

        expect(files).toHaveLength(DOCUMENTS);
        const failed = files.filter(
          (_file, index) => outcome.results[index]?.ok === false,
        );
        expect(failed).toHaveLength(8);
        expect(failed.map((file) => file.id)).toContain("n0077");
        for (const [index, file] of files.entries()) {
          const result = outcome.results[index];
          if (result?.ok !== false) continue;
          // Every file of the batch is named: any of them can be the cause.
          expect(result.diagnostics).toEqual([
            expect.objectContaining({
              code: "validation-failed",
              severity: "error",
              file: file.absPath,
              source: "notes",
              message: expect.stringContaining(
                "did not finish in a worker thread within 2s",
              ),
              hint: expect.stringContaining("workers: false"),
            }),
          ]);
        }
        // The other documents were all validated by workers: the blocked
        // files are not handed back to block the main thread too.
        expect(
          outcome.results.filter((result) => result?.ok === true),
        ).toHaveLength(DOCUMENTS - 8);
        expect(outcome.unusable).toBe(false);
      }).pipe(Effect.provide(PoolLive)),
  );

  // Failure: the main thread waits two minutes for workers that never
  // load the project, and tries the same again in every build.
  it("gives up on workers that never load the project, and says they are unusable", async () => {
    const dir = await project(
      config(
        "() => threadId",
        "workers: 2",
        "if (!isMainThread) await new Promise(() => {});",
      ),
    );
    const outcome = await validateInWorkers(
      {
        rootDir: dir.dir,
        configPath: dir.path("anhur.config.ts"),
        mode: "build",
        fingerprint: "unused: the config never loads",
        publicBase: undefined,
        assetRoots: [],
      },
      [],
      { workers: 2, dryRun: true, readAt: 0, startTimeoutMs: 1500 },
    );
    expect(outcome.problem).toContain(
      "a worker did not load the project within 1s 500ms",
    );
    expect(outcome.unusable).toBe(true);
  });
});
