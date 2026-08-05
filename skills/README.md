# Agent skills

Public skills for [skills.sh](https://skills.sh/) / [`npx skills`](https://github.com/vercel-labs/skills).

## Install (consumers)

```sh
npx skills add DobroslavRadosavljevic/anhur --skill anhur
```

Or install everything discovered in the repo (includes internal `.agents/skills` if present):

```sh
npx skills add DobroslavRadosavljevic/anhur
```

Prefer **`--skill anhur`** so only the Anhur integration skill is installed.

Badge:

```md
[![skills.sh](https://skills.sh/b/DobroslavRadosavljevic/anhur)](https://skills.sh/DobroslavRadosavljevic/anhur)
```

## Layout

| Path               | Audience                                              |
| ------------------ | ----------------------------------------------------- |
| `skills/anhur/`    | Public — integrate `@anhur/*` into any app            |
| `.agents/skills/*` | Internal monorepo agent workflows (Effect, Vitest, …) |

Discovery: the skills CLI walks `skills/` and `.agents/skills/` (and other agent dirs). No separate registry publish step — listing on skills.sh comes from install telemetry after the repo is public.
