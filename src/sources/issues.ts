import {
  TRIGGER_LABEL,
  STATE_LABEL,
  type TicketIssue,
  type TicketState,
  isActorAllowed,
  parseAllowlist,
  stateFromLabels,
} from "../core/tickets.js";

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  author: string;
  labels: string[];
  state?: string;
}

/** Issue the agent must skip: not actionable for it (wrong label/state/actor), with a human-readable reason. */
export interface SkippedIssue {
  issue: RawIssue;
  reason: string;
}

export type IssueDecision = { action: "run"; state: TicketState; issue: TicketIssue } | { action: "skip"; reason: string };

/**
 * Decide whether a labeled issue should trigger the agent.
 * Gate order: open issue -> has trigger label -> actor allowlist -> not already in a terminal/working FSM state.
 */
export function decideIssue(
  raw: RawIssue,
  options: { allowlistRaw: string | undefined; agentLogin?: string },
): IssueDecision {
  if (raw.state && raw.state !== "open") {
    return { action: "skip", reason: `issue is ${raw.state}` };
  }
  if (!raw.labels.includes(TRIGGER_LABEL)) {
    return { action: "skip", reason: `no "${TRIGGER_LABEL}" label` };
  }
  const allowlist = parseAllowlist(options.allowlistRaw);
  if (!isActorAllowed(raw.author, allowlist)) {
    return { action: "skip", reason: `author ${raw.author} is not in the allowlist` };
  }
  const state = stateFromLabels(raw.labels);
  if (state === "working") {
    return { action: "skip", reason: "already agent/working" };
  }
  if (state === "done") {
    return { action: "skip", reason: "already agent/done" };
  }
  if (options.agentLogin && raw.author.trim().toLowerCase() === options.agentLogin.toLowerCase()) {
    return { action: "skip", reason: "skip own activity (anti-loop)" };
  }
  return {
    action: "run",
    state,
    issue: {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      author: raw.author,
      labels: raw.labels,
    },
  };
}

/** Next FSM label to set after a run finishes. */
export function terminalStateFor(runStatus: "done" | "budget_exhausted" | "llm_error" | string): TicketState {
  if (runStatus === "done") return "done";
  if (runStatus === "budget_exhausted") return "blocked";
  return "failed";
}

/** Labels to add/remove when moving the FSM forward. */
export function labelChanges(next: TicketState, current: TicketState): { add: string[]; remove: string[] } {
  const add = [STATE_LABEL[next]];
  const remove: string[] = [];
  if (current !== next) remove.push(STATE_LABEL[current]);
  return { add, remove };
}
