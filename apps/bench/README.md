# Anhur benchmark

Times an Anhur build on a generated content project: MDX posts and Markdown pages in two locales, JSON products, YAML authors, one image per four documents, views and a search index. The content is the same on every run of the same size.

Run it from `apps/bench`. The repo root has no `bench` script.

```sh
cd apps/bench
bun run bench                       # 1,000 and 5,000 documents
bun run bench --sizes 200,10000     # other sizes (20 documents or more)
bun run bench --runs 5              # more runs of the scenarios that start a new process (default 3)
bun run bench --json result.json    # keep the numbers
bun run bench:node                  # the same on Node
```

## How it measures

`src/run.ts` prepares the project and builds nothing itself. It starts `src/step.ts` in a child process for every build it times. The child uses the runtime of the parent (Bun, or Node with jiti). So no build starts with compilers, modules or caches in memory that an earlier build loaded.

| Scenario                   | Process                | Runs     | What it measures                                                                                                                                                                               |
| -------------------------- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cold build                 | new for each run       | `--runs` | `build()` with no output and no caches. Each run deletes `.anhur` first.                                                                                                                       |
| rebuild, no change         | one long-lived session | 5        | `session.build()` again, no file changed.                                                                                                                                                      |
| rebuild, 1 file edited     | the same session       | 5        | Text added to the body of one post. This is the cheapest edit: only the document and the post list change.                                                                                     |
| rebuild, 1 title edited    | the same session       | 5        | The `title` of one post changed. The post list, two views and the search index change too.                                                                                                     |
| rebuild, 1 file added      | the same session       | 5        | One post added.                                                                                                                                                                                |
| warm start (new session)   | new for each run       | `--runs` | `build()` with the caches of the last build, no file changed. This is a second `anhur build` on the same machine.                                                                              |
| check (new session)        | new for each run       | `--runs` | `check()` (what `anhur check` runs) with the same caches.                                                                                                                                      |
| new session, files touched | new for each run       | `--runs` | `build()` with the same caches after every content file and the config got a new file time. The content is the same. A CI run with a restored `.anhur` folder and a new checkout is like this. |

A scenario that starts a new process has two lines:

- The line with the scenario name is the time of `build()` or `check()`, measured in the child.
- The line `…, whole process` is the time of the child from start to exit, measured in the parent. It adds the start of the runtime, the module loading and the exit.

Each line shows the median of its runs and, in brackets, the fastest run. The progress lines also show the stages of the median run that took a millisecond or more.

Memory is the highest resident memory (`maxRSS`) of a process:

- `peak memory, first build` is the peak of a cold build process (median of the cold runs).
- `peak memory, session (rebuilds)` is the peak of the session process: one warm first build and all rebuilds.

Details:

- The session starts with the caches of the cold build. Its first build is not reported.
- After each edit, the file gets its old content and file time back and one build runs that is not timed.
- Touched files get a file time one minute in the past. Anhur reads a file again when it changed in the last seconds before a build, and a checkout is older than that when a build starts.
- `new session, files touched` runs last, because the new file times change what a later process reads.
- The benchmark cannot clear the file cache of the operating system. It is warm in every scenario.
- The child loads the Anhur packages from TypeScript source (on Node through jiti). A published package is built JavaScript, so its `whole process` time is not the same.
- `--json` writes every number: all runs, median, fastest run, the stages of the median run, and the memory of every process.

The project is written to `.tmp/n<size>` and reused by later runs. It is generated again when `GENERATOR_VERSION` in `src/generate.ts` changes. Raise that number when you change the generator.

## Numbers of `main` ("before")

The same script runs on `main`. Builds of `main` report no stages, so the stage lists are empty. From the repo root:

```sh
git worktree add ../anhur-main main
rsync -a --exclude node_modules --exclude .tmp --exclude .turbo apps/bench/ ../anhur-main/apps/bench/
cd ../anhur-main && bun install
cd apps/bench && bun src/run.ts --json before.json
```
