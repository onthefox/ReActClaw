/** Ticket FSM and access gate (dsh-superagent patterns, small version). */

export const TRIGGER_LABEL = "agent";

export type TicketState = "received" | "working" | "done" | "blocked" | "failed";

export const STATE_LABEL: Record<TicketState, string> = {
  received: "agent/received",
  working: "agent/working",
  done: "agent/done",
  blocked: "agent/blocked",
  failed: "agent/failed",
};

const TRANSITIONS: Record<TicketState, TicketState[]> = {
  received: ["working", "blocked", "failed"],
  working: ["done", "blocked", "failed", "working"],
  blocked: ["working", "failed", "done"],
  failed: ["working", "blocked", "done"],
  done: [],
};

export function canTransition(from: TicketState, to: TicketState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TicketIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
}

export function parseAllowlist(raw: string | undefined): string[] {
  return [...new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  )];
}

/** Empty allowlist is a closed gate: nobody may trigger the agent. Matching is case-insensitive. */
export function isActorAllowed(author: string, allowlist: string[]): boolean {
  const actor = author.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === actor);
}

export function stateFromLabels(labels: string[]): TicketState {
  for (const state of Object.keys(STATE_LABEL) as TicketState[]) {
    if (labels.includes(STATE_LABEL[state])) return state;
  }
  return "received";
}

export function branchForTicket(number: number): string {
  return `agent/ticket-${number}`;
}
