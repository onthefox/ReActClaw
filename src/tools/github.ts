import { defaultExec, errorMessage, type ExecFn } from "./git.js";
import type { AgentTool } from "../core/loop.js";

export type { ExecFn };

export interface GithubToolOptions {
  /** owner/name, e.g. onthefox/ReActClaw */
  repo: string;
  baseBranch?: string;
  exec?: ExecFn;
}

const GH_TIMEOUT_MS = 30_000;

function ghExecFactory(): ExecFn {
  return async (cmd, args, _opts) => {
    if (cmd !== "gh") throw new Error("github tools only run gh");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("gh", args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: GH_TIMEOUT_MS,
    });
    return stdout;
  };
}

export function githubTools(opts: GithubToolOptions): AgentTool[] {
  const repo = opts.repo;
  const baseBranch = opts.baseBranch ?? "main";
  const exec = opts.exec ?? ghExecFactory();
  const gh = (args: string[]): Promise<string> => exec("gh", ["--repo", repo, ...args], { cwd: "." });

  const issue: AgentTool = {
    name: "github_issue",
    description: "Read a GitHub issue: title, author, labels, body (truncated).",
    parameters: {
      type: "object",
      properties: { number: { type: "number", description: "Issue number" } },
      required: ["number"],
    },
    async run(args) {
      const n = args.number;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        return { ok: false, output: "issue number is required" };
      }
      try {
        const out = await gh(["issue", "view", String(n), "--json", "number,title,author,labels,body,state"]);
        const data = JSON.parse(out) as {
          number: number;
          title: string;
          author: { login: string };
          labels: Array<{ name: string }>;
          body: string | null;
          state: string;
        };
        const body = (data.body ?? "").slice(0, 4000);
        return {
          ok: true,
          output: `#${data.number} [${data.state}] "${data.title}" by ${data.author.login}\nlabels: ${data.labels
            .map((l) => l.name)
            .join(", ")}\n\n${body}`,
        };
      } catch (err) {
        return { ok: false, output: `gh issue view failed: ${errorMessage(err)}` };
      }
    },
  };

  const comment: AgentTool = {
    name: "github_comment",
    description: "Post a comment on a GitHub issue.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue number" },
        body: { type: "string", description: "Comment body (markdown)" },
      },
      required: ["number", "body"],
    },
    async run(args) {
      const n = args.number;
      const body = args.body;
      if (typeof n !== "number" || typeof body !== "string" || body.trim().length === 0) {
        return { ok: false, output: "number and body are required" };
      }
      try {
        await gh(["issue", "comment", String(n), "--body", body]);
        return { ok: true, output: `commented on #${n}` };
      } catch (err) {
        return { ok: false, output: `gh issue comment failed: ${errorMessage(err)}` };
      }
    },
  };

  const prCreate: AgentTool = {
    name: "github_pr_create",
    description: `Open a draft pull request. Never merges; targets ${baseBranch} for human review.`,
    parameters: {
      type: "object",
      properties: {
        head: { type: "string", description: "Source branch" },
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR body (markdown)" },
      },
      required: ["head", "title", "body"],
    },
    async run(args) {
      const head = args.head;
      const title = args.title;
      const body = args.body;
      if (typeof head !== "string" || typeof title !== "string" || typeof body !== "string") {
        return { ok: false, output: "head, title and body are required" };
      }
      if (head.toLowerCase() === baseBranch.toLowerCase()) {
        return { ok: false, output: `refusing to open a PR from ${baseBranch} into itself` };
      }
      try {
        const out = await gh([
          "pr",
          "create",
          "--draft",
          "--base",
          baseBranch,
          "--head",
          head,
          "--title",
          title,
          "--body",
          body,
        ]);
        return { ok: true, output: out.trim().split("\n").pop() ?? "PR created" };
      } catch (err) {
        return { ok: false, output: `gh pr create failed: ${errorMessage(err)}` };
      }
    },
  };

  const labels: AgentTool = {
    name: "github_labels",
    description: "Add/remove labels on a GitHub issue.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue number" },
        add: { type: "array", items: { type: "string" }, description: "Labels to add" },
        remove: { type: "array", items: { type: "string" }, description: "Labels to remove" },
      },
      required: ["number"],
    },
    async run(args) {
      const n = args.number;
      if (typeof n !== "number") return { ok: false, output: "number is required" };
      try {
        const add = Array.isArray(args.add) ? args.add.filter((s): s is string => typeof s === "string") : [];
        const remove = Array.isArray(args.remove) ? args.remove.filter((s): s is string => typeof s === "string") : [];
        if (add.length > 0) await gh(["issue", "edit", String(n), "--add-label", add.join(",")]);
        for (const label of remove) {
          await gh(["issue", "edit", String(n), "--remove-label", label]);
        }
        return { ok: true, output: `labels updated on #${n}` };
      } catch (err) {
        return { ok: false, output: `gh labels failed: ${errorMessage(err)}` };
      }
    },
  };

  return [issue, comment, prCreate, labels];
}
