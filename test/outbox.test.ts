import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Outbox } from "../src/core/outbox.js";

test("outbox: enqueue persists a pending JSONL entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reactclaw-outbox-"));
  const file = path.join(dir, "outbox.jsonl");
  try {
    const outbox = new Outbox(file);
    const entry = await outbox.enqueue("label", { number: 7, add: ["agent/working"] });
    assert.equal(entry.status, "pending");
    assert.equal(entry.kind, "label");
    const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string).payload, { number: 7, add: ["agent/working"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbox: flush delivers pending entries and marks them sent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reactclaw-outbox-"));
  const file = path.join(dir, "outbox.jsonl");
  try {
    const outbox = new Outbox(file);
    await outbox.enqueue("comment", { number: 1, body: "hello" });
    await outbox.enqueue("label", { number: 1, add: ["agent/done"] });
    const delivered: Array<{ kind: string; payload: unknown }> = [];
    const report = await outbox.flush(async (kind, payload) => {
      delivered.push({ kind, payload });
    });
    assert.equal(report.sent, 2);
    assert.equal(report.failed, 0);
    assert.equal(delivered.length, 2);
    const entries = await outbox.list();
    assert.ok(entries.every((e) => e.status === "sent"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbox: retried entries stay pending until maxAttempts, then fail", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reactclaw-outbox-"));
  const file = path.join(dir, "outbox.jsonl");
  try {
    const outbox = new Outbox(file, 2);
    await outbox.enqueue("label", { number: 3, add: ["agent/failed"] });
    let calls = 0;
    const report1 = await outbox.flush(async () => {
      calls += 1;
      throw new Error("gh down");
    });
    assert.equal(report1.sent, 0);
    assert.equal(report1.pending, 1);
    assert.equal(report1.failed, 0);
    assert.equal(calls, 1);

    const report2 = await outbox.flush(async () => {
      calls += 1;
      throw new Error("gh still down");
    });
    assert.equal(report2.failed, 1);
    assert.equal(calls, 2);

    const entries = await outbox.list();
    assert.equal(entries[0]?.status, "failed");
    assert.equal(entries[0]?.attempts, 2);
    assert.match(entries[0]?.lastError ?? "", /gh still down/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbox: entries survive process restarts (reload from disk)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reactclaw-outbox-"));
  const file = path.join(dir, "outbox.jsonl");
  try {
    const first = new Outbox(file);
    await first.enqueue("comment", { number: 9, body: "persisted" });
    const second = new Outbox(file);
    const entries = await second.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, "pending");
    const report = await second.flush(async () => {});
    assert.equal(report.sent, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
