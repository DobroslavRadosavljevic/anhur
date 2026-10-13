# Anhur benchmark

Times an Anhur build on a generated content project: MDX posts and Markdown pages in two locales, JSON products, YAML authors, one image per four documents, views and a search index. The content is the same on every run of the same size.

```sh
bun run bench                       # 1,000 and 5,000 documents
bun run bench -- --sizes 10000      # another size
bun run bench -- --json result.json # keep the numbers
bun run bench:node                  # the same on Node
```

Scenarios:

| Scenario                 | What it measures                                                   |
| ------------------------ | ------------------------------------------------------------------ |
| cold build               | First build: no output, no caches                                  |
| rebuild, no change       | A second build in the same session                                 |
| rebuild, 1 file edited   | One post changed, same session (what a dev server does on save)    |
| rebuild, 1 file added    | One post added, same session                                       |
| warm start (new session) | A new session with the caches of the last one (restart, second CI) |
| check (new session)      | `anhur check` with warm caches                                     |

Each line also shows the stages of that build that took a millisecond or more.

The project is written to `.tmp/n<size>` and reused by later runs. Delete the folder to generate it again. Every size runs in its own process.
