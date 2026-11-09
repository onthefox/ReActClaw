import { appendFile } from "node:fs/promises";
import type { ChatFn } from "./core/loop.js";
import { runLoop, type TraceEntry } from "./core/loop.js";
import { Outbox, type FlushReport, type OutboxSender } from "./core/outbox.js";
import { branchForTicket, STATE_LABEL } from "./core/tickets.js";
import type { Budget } from "./core/budget.js";
import { decideIssue, labelChanges, terminalStateFor, type RawIssue } from "./sources/issues.js";
import { defaultExec, errorMessage, type ExecFn } from "./tools/git.js";
import { gitTools } from "./tools/git.js";
import { githubTools } from "./tools/github.js";
import { webFetchTool } from "./tools/web.js";
import { shellTool } from "./tools/shell.js";
import { filesTools } from "./tools/files.js";
import { ToolRegistry } from "./tools/registry.js";

export interface TicketOptions {
  repo: string;
  ticket: number;
  workspace: string;
  outboxFile: string;
  traceFile?: string;
  system: string;
  llm: ChatFn;
  budget: Budget;
  allowlistRaw: string | undefined;
  agentLogin?: string;
  baseBranch?: string;
  exec?: ExecFn;
}

export interface TicketOutcome {
  ran: boolean;
  skipReason?: string;
  loopStatus?: "done" | "budget_exhausted" | "llm_error";
  finalMessage?: string;
  ticketState?: string;
  prUrl?: string;
  flush?: FlushReport;
  error?: string;
}

async function gh(exec: ExecFn, repo: string, args: string[]): Promise<string> {
  return exec("gh", ["--repo", repo, ...args], { cwd: "." });
}

export async function fetchIssue(repo: string, ticket: number, exec: ExecFn = defaultExec): Promise<RawIssue> {
  const out = await gh(exec, repo, [
    "issue",
    "view",
    String(ticket),
    "--json",
    "number,title,body,author,labels,state",
  ]);
  const data = JSON.parse(out) as {
    number: number;
    title: string;
    body: string | null;
    author: { login: string };
    labels: Array<{ name: string }>;
    state: string;
  };
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    author: data.author.login,
    labels: data.labels.map((l) => l.name),
    state: data.state,
  };
}

function taskFor(issue: { number: number; title: string; body: string; author: string; labels: string[] }, branch: string): string {
  return [
    `GitHub issue #${issue.number}: ${issue.title}`,
    `Author: ${issue.author}`,
    `Labels: ${issue.labels.join(", ")}`,
    "",
    issue.body,
    "",
    "Instructions:",
    `- You are in a git checkout of this repository, on branch ${branch}.`,
    "- Implement the requested change. Verify your work (typecheck/tests) before finishing.",
    "- Commit with git_commit and push with git_push. Never push to main/master; never force-push.",
    "- If you cannot proceed, say exactly what is blocking you in your final message.",
    "- Final message: a short summary of what changed and why (it will be posted to the issue).",
  ].join("\n");
}

export async function runTicket(opts: TicketOptions): Promise<TicketOutcome> {
  const exec = opts.exec ?? defaultExec;
  const baseBranch = opts.baseBranch ?? "main";
  const outbox = new Outbox(opts.outboxFile);
  const send: OutboxSender = async (kind, payload) => {
    const p = payload as { number: number; add?: string[]; remove?: string[]; body?: string };
    if (kind === "label") {
      const args = ["issue", "edit", String(p.number)];
      if (p.add && p.add.length > 0) args.push("--add-label", p.add.join(","));
      for (const label of p.remove ?? []) args.push("--remove-label", label);
      await gh(exec, opts.repo, args);
    } else if (kind === "comment") {
      await gh(exec, opts.repo, ["issue", "comment", String(p.number), "--body", p.body ?? ""]);
    } else {
      throw new Error(`unknown outbox kind: ${kind}`);
    }
  };

  try {
    const raw = await fetchIssue(opts.repo, opts.ticket, exec);
    const decision = decideIssue(raw, { allowlistRaw: opts.allowlistRaw, agentLogin: opts.agentLogin });
    if (decision.action === "skip") {
      return { ran: false, skipReason: decision.reason };
    }
    const issue = decision.issue;
    const branch = branchForTicket(issue.number);

    const trace = async (entry: TraceEntry): Promise<void> => {
      if (opts.traceFile) await appendFile(opts.traceFile, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
    };

    // FSM: received -> working (queued, not applied directly).
    const current = decision.state;
    await outbox.enqueue("label", { number: issue.number, ...labelChanges("working", current) });
    await outbox.flush(send);

    // Workspace: branch for this ticket.
    const registry = new ToolRegistry().add(
      shellTool({ cwd: opts.workspace }),
      ...filesTools({ root: opts.workspace }),
      ...gitTools({ cwd: opts.workspace, exec }),
      ...githubTools({ repo: opts.repo, baseBranch, exec }),
      webFetchTool,
    );
    const branchTool = registry.get("git_branch");
    if (!branchTool) throw new Error("git_branch tool missing");
    const branchResult = await branchTool.run({ name: branch });
    if (!branchResult.ok) {
      await outbox.enqueue("comment", {
        number: issue.number,
        body: `ReActClaw could not create branch \`${branch}\`: ${branchResult.output}`,
      });
      await outbox.enqueue("label", { number: issue.number, ...labelChanges("failed", "working") });
      const flush = await outbox.flush(send);
      return { ran: true, loopStatus: "llm_error", finalMessage: branchResult.output, ticketState: STATE_LABEL.failed, flush };
    }

    const result = await runLoop({
      llm: opts.llm,
      tools: registry.list(),
      system: opts.system,
      task: taskFor(issue, branch),
      maxSteps: opts.budget.maxSteps,
      deadlineMs: opts.budget.maxMs,
      trace,
    });

    const terminal = terminalStateFor(result.status);
    let prUrl: string | undefined;
    if (result.status === "done") {
      const prTool = registry.get("github_pr_create");
      if (prTool) {
        const pr = await prTool.run({
          head: branch,
          title: `[agent] ticket #${issue.number}: ${issue.title}`,
          body: `Fixes #${issue.number}\n\nCreated by ReActClaw from issue #${issue.number}. Draft for human review — do not auto-merge.\n\n## Agent summary\n\n${result.finalMessage}`,
        });
        if (pr.ok) prUrl = pr.output;
      }
    }

    const commentBody = [
      `**ReActClaw run finished** — status: \`${result.status}\` (steps: ${result.steps})`,
      prUrl ? `Draft PR: ${prUrl}` : "No PR created (no pushed changes, or PR creation failed).",
      "",
      "## Summary",
      result.finalMessage || "(no summary)",
      "",
      "<!-- reactclaw:ticket-" + issue.number + " -->",
    ].join("\n");

    await outbox.enqueue("comment", { number: issue.number, body: commentBody });
    await outbox.enqueue("label", { number: issue.number, ...labelChanges(terminal, "working") });
    const flush = await outbox.flush(send);

    return {
      ran: true,
      loopStatus: result.status,
      finalMessage: result.finalMessage,
      ticketState: STATE_LABEL[terminal],
      prUrl,
      flush,
    };
  } catch (err) {
    return { ran: false, error: errorMessage(err) };
  }
}
