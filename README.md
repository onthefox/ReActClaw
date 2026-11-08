# ReActClaw

Autonomous ReAct coding agent in TypeScript: it takes a task, works in a sandboxed
workspace with shell/file tools, and reports back. Runs locally from the CLI and
(via GitHub Actions) from an issue label — the piclaw-bot / dsh-superagent pattern,
small and dependency-free.

## Layout

- `src/core/llm.ts` — OpenAI-compatible chat client (any provider: Ollama, DeepSeek, OpenRouter…)
- `src/core/loop.ts` — ReAct loop: think → act (tool call) → observe → … → final answer, with a JSONL trace
- `src/core/budget.ts` — step/time limits
- `src/core/pool.ts` — `FreePoolRouter`: failover across free OpenAI-compatible endpoints with cooldowns
- `src/tools/` — `shell` (denylist + timeout + process-tree kill), `files_list/read/write` (workspace-jailed), registry
- `src/cli.ts` — local entry point
- `scripts/probe-pool.ts` — health probe for the pool entries
- `prompts/system.md` — role and working discipline
- `test/` — node:test unit tests

## Setup

Prerequisites: Node ≥ 20 and npm. Git is recommended; `gh` (GitHub CLI) will be needed only for the Phase 2 GitHub loop.

```bash
npm install
npm test
npm run typecheck
```

## Configure a model

| Variable | Meaning | Default |
|---|---|---|
| `AGENT_BASE_URL` | OpenAI-compatible base URL | `http://localhost:11434/v1` (Ollama) |
| `AGENT_API_KEY` | API key (empty for local Ollama) | — |
| `AGENT_MODEL` | Model name/tag | `hf.co/unsloth/GLM-4.6V-Flash-GGUF:Q4_K_M` |
| `AGENT_MAX_STEPS` | Max ReAct steps per run | `24` |
| `AGENT_MAX_SECONDS` | Max wall-clock seconds per run | `600` |
| `AGENT_ROUTER` | `pool` (default) or `direct` | `pool` |

## Routing: free pool or direct

By default (no `AGENT_BASE_URL` set, `AGENT_ROUTER` not `direct`) requests go
through the built-in **FreePoolRouter**: three free OpenAI-compatible endpoints
tried in order, with per-entry cooldowns (30 s base, 60 s on HTTP 429, exponential
backoff capped at 10 min) and a `PoolExhaustedError` when everything is down:

| Entry | Base URL | Model |
|---|---|---|
| `kilo` | `https://ai-gateway.kilo.ai/api/v1` | `kilo-auto/free` |
| `pollinations` | `https://text.pollinations.ai/openai` | `openai` |
| `opencode` | `https://opencode.ai/zen/v1` | `deepseek-v4-flash-free` |

Direct mode (one provider, e.g. local Ollama) is used when you set `AGENT_BASE_URL`,
or force it with `AGENT_ROUTER=direct`.

Check which entries are alive right now:

```bash
npx tsx scripts/probe-pool.ts
```

## Run

```bash
npm run agent -- --task "Create hello.py that prints the Node version reasoning, run it with node --version to verify the environment"
```

Each run writes a JSONL trace to `runs/trace-*.jsonl` (every assistant step, tool
result and the final answer).

## Safety model

- All file operations are jailed to the workspace directory (`--workspace`, default `./workspace`).
- Shell commands pass a denylist (`rm -rf`, force push, `git reset --hard`, drive formatting, piping into shells, …); output is capped and long commands are killed at the timeout.
- The agent never pushes to `main` and never merges — PRs from the GitHub loop go to a review queue.

## Verification

Verified on a fresh clone (Windows, Node 22): `npm install` clean, `npm test`
14/14, `npm run typecheck` clean, live pool probe answered from the first entry.

## Roadmap

- **Phase 2** — GitHub integration: `git`/`github` tools, ticket FSM driven by issue labels, gated via allowlist.
- **Phase 3** — autonomous loop on GitHub Actions: react to labeled issues, open draft PRs, outbox pattern.
- **Phase 4** (optional) — scheduler and twin-account flow, status panel.
