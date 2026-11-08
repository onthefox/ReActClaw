import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { shellTool } from "../src/tools/shell.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rmRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(250);
    }
  }
}

test("shell runs a command and captures output", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "reactclaw-shell-"));
  try {
    const shell = shellTool({ cwd, timeoutMs: 15_000 });
    const res = await shell.run({ command: "node --version" });
    assert.equal(res.ok, true);
    assert.match(res.output, /^exit code: 0\nv\d+/);
  } finally {
    await rmRetry(cwd);
  }
});

test("shell blocks denylisted commands without running them", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "reactclaw-shell-"));
  try {
    const shell = shellTool({ cwd, timeoutMs: 5_000 });
    const res = await shell.run({ command: "rm -rf /" });
    assert.equal(res.ok, false);
    assert.match(res.output, /blocked by denylist/);

    const force = await shell.run({ command: "git push --force origin main" });
    assert.equal(force.ok, false);
    assert.match(force.output, /git push --force/);
  } finally {
    await rmRetry(cwd);
  }
});

test("shell kills commands that exceed the timeout", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "reactclaw-shell-"));
  try {
    const sleepFile = path.join(cwd, "sleep.js");
    await writeFile(sleepFile, "setTimeout(function(){}, 30000);\n", "utf8");
    const shell = shellTool({ cwd, timeoutMs: 1_000 });
    const res = await shell.run({ command: "node sleep.js" });
    assert.equal(res.ok, false);
    assert.match(res.output, /timed out/);
  } finally {
    await rmRetry(cwd);
  }
});
