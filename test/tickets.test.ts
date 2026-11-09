import test from "node:test";
import assert from "node:assert/strict";
import {
  TRIGGER_LABEL,
  STATE_LABEL,
  canTransition,
  parseAllowlist,
  isActorAllowed,
  stateFromLabels,
  branchForTicket,
} from "../src/core/tickets.js";

test("FSM: received can move to working, blocked, failed but not done", () => {
  assert.equal(canTransition("received", "working"), true);
  assert.equal(canTransition("received", "blocked"), true);
  assert.equal(canTransition("received", "failed"), true);
  assert.equal(canTransition("received", "done"), false);
});

test("FSM: done is terminal (no outgoing transitions)", () => {
  for (const to of ["received", "working", "blocked", "failed", "done"] as const) {
    assert.equal(canTransition("done", to), false, `done -> ${to}`);
  }
});

test("FSM: working can reach all terminal states and stay", () => {
  assert.equal(canTransition("working", "done"), true);
  assert.equal(canTransition("working", "blocked"), true);
  assert.equal(canTransition("working", "failed"), true);
  assert.equal(canTransition("working", "working"), true);
  assert.equal(canTransition("working", "received"), false);
});

test("allowlist: comma parsing, trimming, lowercasing", () => {
  assert.deepEqual(parseAllowlist(" Alice ,BOB,alice "), ["alice", "bob"]);
  assert.deepEqual(parseAllowlist(""), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test("allowlist: empty allowlist is a closed gate", () => {
  assert.equal(isActorAllowed("alice", []), false);
  assert.equal(isActorAllowed("alice", ["alice"]), true);
  assert.equal(isActorAllowed("  Alice ", ["alice"]), true);
  assert.equal(isActorAllowed("alice", ["Alice", "bob"]), true);
});

test("stateFromLabels reads the FSM label or defaults to received", () => {
  assert.equal(stateFromLabels([TRIGGER_LABEL, STATE_LABEL.working]), "working");
  assert.equal(stateFromLabels([STATE_LABEL.done]), "done");
  assert.equal(stateFromLabels([TRIGGER_LABEL]), "received");
  assert.equal(stateFromLabels([]), "received");
});

test("branchForTicket is namespaced and non-protected", () => {
  assert.equal(branchForTicket(42), "agent/ticket-42");
});
