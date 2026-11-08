import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { filesTools } from "../src/tools/files.js";

test("files tools write, read and list inside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reactclaw-files-"));
  try {
    const [list, read, write] = filesTools({ root });
    assert.ok(list && read && write);

    const w = await write.run({ path: "src/deep/a.txt", content: "hello" });
    assert.equal(w.ok, true);

    const r = await read.run({ path: "src/deep/a.txt" });
    assert.equal(r.ok, true);
    assert.equal(r.output, "hello");

    const l = await list.run({ path: "src" });
    assert.equal(l.ok, true);
    assert.match(l.output, /^deep\/$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files tools refuse to escape the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reactclaw-files-"));
  try {
    const [list, read, write] = filesTools({ root });
    assert.ok(list && read && write);

    const w = await write.run({ path: "../outside.txt", content: "x" });
    assert.equal(w.ok, false);
    assert.match(w.output, /escapes workspace/);

    const r = await read.run({ path: "C:\\Windows\\win.ini" });
    assert.equal(r.ok, false);

    const l = await list.run({ path: "../../" });
    assert.equal(l.ok, false);
    assert.match(l.output, /escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files_read reports missing files without throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reactclaw-files-"));
  try {
    const [, read] = filesTools({ root });
    assert.ok(read);
    const r = await read.run({ path: "nope/missing.txt" });
    assert.equal(r.ok, false);
    assert.match(r.output, /cannot read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
