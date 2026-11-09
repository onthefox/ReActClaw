import test from "node:test";
import assert from "node:assert/strict";
import { decideIssue, terminalStateFor, labelChanges, type RawIssue } from "../src/sources/issues.js";
import { STATE_LABEL } from "../src/core/tickets.js";

function issue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 5,
    title: "Do something",
    body: "please",
    author: "alice",
    labels: ["agent"],
    state: "open",
    ...overrides,
  };
}

const OPEN_GATE = { allowlistRaw: "alice,bob" };

test("trigger: runs for open issue with agent label and allowlisted author", () => {
  const d = decideIssue(issue(), OPEN_GATE);
  assert.equal(d.action, "run");
  if (d.action === "run") {
    assert.equal(d.state, "received");
    assert.equal(d.issue.number, 5);
    assert.equal(d.issue.author, "alice");
  }
});

test("trigger: skips closed issues", () => {
  const d = decideIssue(issue({ state: "closed" }), OPEN_GATE);
  assert.equal(d.action, "skip");
  assert.match(d.action === "skip" ? d.reason : "", /closed/);
});

test("trigger: skips issues without the agent label", () => {
  const d = decideIssue(issue({ labels: ["bug"] }), OPEN_GATE);
  assert.equal(d.action, "skip");
});

test("trigger: empty allowlist is a closed gate", () => {
  const d = decideIssue(issue(), { allowlistRaw: undefined });
  assert.equal(d.action, "skip");
  const d2 = decideIssue(issue(), { allowlistRaw: "" });
  assert.equal(d2.action, "skip");
});

test("trigger: skips non-allowlisted authors", () => {
  const d = decideIssue(issue({ author: "mallory" }), OPEN_GATE);
  assert.equal(d.action, "skip");
  assert.match(d.action === "skip" ? d.reason : "", /mallory/);
});

test("trigger: skips already-working and already-done issues (anti-loop)", () => {
  const working = decideIssue(issue({ labels: ["agent", STATE_LABEL.working] }), OPEN_GATE);
  assert.equal(working.action, "skip");
  const done = decideIssue(issue({ labels: ["agent", STATE_LABEL.done] }), OPEN_GATE);
  assert.equal(done.action, "skip");
});

test("trigger: skips the agent's own activity by login", () => {
  const d = decideIssue(issue({ author: "reactclaw-bot" }), { allowlistRaw: "reactclaw-bot", agentLogin: "reactclaw-bot" });
  assert.equal(d.action, "skip");
  assert.match(d.action === "skip" ? d.reason : "", /anti-loop/);
});

test("trigger: failed/blocked issues may be retried", () => {
  const failed = decideIssue(issue({ labels: ["agent", STATE_LABEL.failed] }), OPEN_GATE);
  assert.equal(failed.action, "run");
  if (failed.action === "run") assert.equal(failed.state, "failed");
  const blocked = decideIssue(issue({ labels: ["agent", STATE_LABEL.blocked] }), OPEN_GATE);
  assert.equal(blocked.action, "run");
  if (blocked.action === "run") assert.equal(blocked.state, "blocked");
});

test("terminalStateFor maps run status to FSM states", () => {
  assert.equal(terminalStateFor("done"), "done");
  assert.equal(terminalStateFor("budget_exhausted"), "blocked");
  assert.equal(terminalStateFor("llm_error"), "failed");
  assert.equal(terminalStateFor("anything-else"), "failed");
});

test("labelChanges adds the next state label and removes the current one", () => {
  assert.deepEqual(labelChanges("working", "received"), { add: ["agent/working"], remove: ["agent/received"] });
  assert.deepEqual(labelChanges("done", "working"), { add: ["agent/done"], remove: ["agent/working"] });
  assert.deepEqual(labelChanges("working", "working"), { add: ["agent/working"], remove: [] });
});
