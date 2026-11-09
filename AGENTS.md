# AGENTS.md

Rules for autonomous ReActClaw runs (CLI `--ticket N` and the GitHub Actions workflow).

## Trigger

1. A human adds the `agent` label to an open issue.
2. The workflow (`on: issues: labeled`) checks the actor against the `AGENT_ACTOR_ALLOWLIST` secret (comma-separated logins). Empty/missing allowlist = closed gate, no run.
3. The runner re-checks the same gate in code (`src/sources/issues.ts`) and skips issues already labeled `agent/working` or `agent/done`.

## Ticket FSM

`agent/received → agent/working → agent/done | agent/blocked | agent/failed`

- Labels are changed through the outbox (`src/core/outbox.ts`) with retries; `agent/done` is terminal.
- Run status → label: `done → agent/done`, `budget_exhausted → agent/blocked`, `llm_error → agent/failed`.

## Safety rules (non-negotiable)

- Never push to `main`/`master`; never force-push; never merge PRs.
- Work only on the ticket branch `agent/ticket-N`, created from the default branch.
- Deliverables land as a **draft PR** targeting the default branch; humans review and merge.
- Issue comments posted by the agent are ignored by the trigger (author allowlist + actor check) — no self-triggering loops.
- One workflow run per issue (`concurrency` group per issue number).
- Workflow permissions are minimal: `contents`, `issues`, `pull-requests` (write) and nothing else.
- `web_fetch` blocks private/loopback addresses and non-HTTP(S) schemes (SSRF guard).

## Budgets

- Defaults: 24 steps, 600 s (`AGENT_MAX_STEPS`, `AGENT_MAX_SECONDS`).
- Workflow hard timeout: 30 minutes.
- Traces (`runs/trace-*.jsonl`) are uploaded as workflow artifacts for every run.

## Setup checklist

1. Add repo secret `AGENT_ACTOR_ALLOWLIST` (e.g. `yourlogin`).
2. Provide an LLM: either the free pool (default) or BYOK via `AGENT_BASE_URL`/`AGENT_API_KEY`/`AGENT_MODEL` (repo variables/secrets).
3. Label an issue `agent` from an allowlisted account.
4. Review the resulting draft PR; merge manually when satisfied.
