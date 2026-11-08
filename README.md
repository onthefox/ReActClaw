# ReActClaw

Autonomous ReAct coding agent in TypeScript: it takes a task, works in a sandboxed
workspace with shell/file tools, and reports back. Runs locally from the CLI and
(via GitHub Actions) from an issue label — the piclaw-bot / dsh-superagent pattern,
small and dependency-free.

## Layout

- `src/core/llm.ts` — OpenAI-compatible chat client (any provider: Ollama, DeepSeek, OpenRouter…)
- `src/core/loop.ts` — ReAct loop: think → act (tool call) → observe → … → final answer, with a JSONL trace
- `src/core/budget.ts` — step/time limits
- `src/tools/` — `shell` (denylist + timeout + process-tree kill), `files_list/read/write` (workspace-jailed), registry
- `src/cli.ts` — local entry point
- `prompts/system.md` — role and working discipline
- `test/` — node:test unit tests

## Setup

Requires Node ≥ 20.

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
