import test from "node:test";
import assert from "node:assert/strict";
import { gitTools, isProtectedBranch, isValidBranchName, type ExecFn } from "../src/tools/git.js";

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
}

function fakeExec(responses: Record<string, string> = {}): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    const key = args.join(" ");
    if (key in responses) return responses[key] ?? "";
    return "";
  };
  return { exec, calls };
}

test("git helpers: protected branches and name validation", () => {
  for (const name of ["main", "MAIN", "master", "HEAD", "head"]) {
    assert.equal(isProtectedBranch(name), true, name);
  }
  assert.equal(isProtectedBranch("agent/ticket-1"), false);

  assert.equal(isValidBranchName("agent/ticket-1"), true);
  assert.equal(isValidBranchName("feature/foo.bar-baz_2"), true);
  assert.equal(isValidBranchName(""), false);
  assert.equal(isValidBranchName("-leading-dash"), false);
  assert.equal(isValidBranchName("has space"), false);
  assert.equal(isValidBranchName("dot..dot"), false);
  assert.equal(isValidBranchName("/leading-slash"), false);
});

test("git_branch refuses protected and invalid names without invoking git", async () => {
  const { exec, calls } = fakeExec();
  const tools = gitTools({ cwd: "X", exec });
  const branch = tools.find((t) => t.name === "git_branch");
  assert.ok(branch);

  const prot = await branch.run({ name: "main" });
  assert.equal(prot.ok, false);
  assert.match(prot.output, /protected/);

  const invalid = await branch.run({ name: "not a branch!" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.output, /invalid branch name/);
  assert.equal(calls.length, 0);
});

test("git_branch creates branch via checkout -B", async () => {
  const { exec, calls } = fakeExec();
  const tools = gitTools({ cwd: "X", exec });
  const branch = tools.find((t) => t.name === "git_branch");
  assert.ok(branch);
  const res = await branch.run({ name: "agent/ticket-7" });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], { cmd: "git", args: ["checkout", "-B", "agent/ticket-7"], cwd: "X" });
});

test("git_commit stages everything, commits, returns short hash", async () => {
  const { exec, calls } = fakeExec({ "rev-parse --short HEAD": "abc1234\n" });
  const tools = gitTools({ cwd: "W", exec });
  const commit = tools.find((t) => t.name === "git_commit");
  assert.ok(commit);
  const res = await commit.run({ message: " do the thing " });
  assert.equal(res.ok, true);
  assert.match(res.output, /abc1234/);
  assert.match(res.output, /do the thing/);
  assert.deepEqual(calls[0], { cmd: "git", args: ["add", "-A", "."], cwd: "W" });
  assert.deepEqual(calls[1], { cmd: "git", args: ["commit", "-m", "do the thing"], cwd: "W" });
});

test("git_push refuses protected current branch, pushes with -u otherwise", async () => {
  const { exec, calls } = fakeExec({ "branch --show-current": "main\n" });
  const tools = gitTools({ cwd: "W", exec });
  const push = tools.find((t) => t.name === "git_push");
  assert.ok(push);

  const refused = await push.run({});
  assert.equal(refused.ok, false);
  assert.match(refused.output, /refusing to push protected branch: main/);
  assert.equal(calls.length, 1);

  const { exec: exec2, calls: calls2 } = fakeExec({ "branch --show-current": "agent/ticket-3\n" });
  const push2 = gitTools({ cwd: "W", exec: exec2 }).find((t) => t.name === "git_push");
  assert.ok(push2);
  const ok = await push2.run({});
  assert.equal(ok.ok, true);
  assert.deepEqual(calls2[1], { cmd: "git", args: ["push", "-u", "origin", "agent/ticket-3"], cwd: "W" });
});
