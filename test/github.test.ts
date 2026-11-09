import test from "node:test";
import assert from "node:assert/strict";
import { githubTools, type ExecFn } from "../src/tools/github.js";

interface Call {
  cmd: string;
  args: string[];
}

function fakeExec(responses: Record<string, string> = {}): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const key = args.join(" ");
    if (key in responses) return responses[key] ?? "";
    return "";
  };
  return { exec, calls };
}

const ISSUE_JSON = JSON.stringify({
  number: 12,
  title: "Fix the flux capacitor",
  author: { login: "onthefox" },
  labels: [{ name: "agent" }, { name: "bug" }],
  body: "It sparks at 88 mph.",
  state: "open",
});

test("github_issue parses gh json output into readable text", async () => {
  const { exec, calls } = fakeExec({ ["--repo o/r issue view 12 --json number,title,author,labels,body,state"]: ISSUE_JSON });
  const tools = githubTools({ repo: "o/r", exec });
  const issue = tools.find((t) => t.name === "github_issue");
  assert.ok(issue);
  const res = await issue.run({ number: 12 });
  assert.equal(res.ok, true);
  assert.match(res.output, /#12 \[open\] "Fix the flux capacitor" by onthefox/);
  assert.match(res.output, /labels: agent, bug/);
  assert.match(res.output, /It sparks at 88 mph\./);
  assert.equal(calls[0]?.cmd, "gh");
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["--repo", "o/r"]);
});

test("github_pr_create always passes --draft and refuses main->main", async () => {
  const { exec, calls } = fakeExec({ "--repo o/r pr create --draft --base main --head agent/ticket-12 --title T --body B": "https://github.com/o/r/pull/5\n" });
  const tools = githubTools({ repo: "o/r", baseBranch: "main", exec });
  const pr = tools.find((t) => t.name === "github_pr_create");
  assert.ok(pr);

  const ok = await pr.run({ head: "agent/ticket-12", title: "T", body: "B" });
  assert.equal(ok.ok, true);
  assert.equal(ok.output, "https://github.com/o/r/pull/5");
  const args = calls[0]?.args ?? [];
  assert.equal(args.includes("--draft"), true);
  assert.equal(args.includes("--base"), true);
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.equal(args[args.indexOf("--head") + 1], "agent/ticket-12");

  const { exec: exec2, calls: calls2 } = fakeExec();
  const pr2 = githubTools({ repo: "o/r", baseBranch: "main", exec: exec2 }).find((t) => t.name === "github_pr_create");
  assert.ok(pr2);
  const refused = await pr2.run({ head: "main", title: "T", body: "B" });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /refusing to open a PR from main into itself/);
  assert.equal(calls2.length, 0);
});

test("github_labels adds and removes labels", async () => {
  const { exec, calls } = fakeExec();
  const tools = githubTools({ repo: "o/r", exec });
  const labels = tools.find((t) => t.name === "github_labels");
  assert.ok(labels);
  const res = await labels.run({ number: 4, add: ["agent/done"], remove: ["agent/working"] });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.args, ["--repo", "o/r", "issue", "edit", "4", "--add-label", "agent/done"]);
  assert.deepEqual(calls[1]?.args, ["--repo", "o/r", "issue", "edit", "4", "--remove-label", "agent/working"]);
});

test("github_comment posts the body", async () => {
  const { exec, calls } = fakeExec();
  const tools = githubTools({ repo: "o/r", exec });
  const comment = tools.find((t) => t.name === "github_comment");
  assert.ok(comment);
  const res = await comment.run({ number: 4, body: "ran fine" });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0]?.args, ["--repo", "o/r", "issue", "comment", "4", "--body", "ran fine"]);
});
