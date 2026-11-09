import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "../core/loop.js";

export type ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<string>;

const execFileAsync = promisify(execFile);

export const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, { cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const BRANCH_RE = /^[a-z0-9][a-z0-9._/-]{0,80}$/i;

export function isProtectedBranch(name: string): boolean {
  const n = name.toLowerCase();
  return n === "main" || n === "master" || n === "head";
}

export function isValidBranchName(name: string): boolean {
  return BRANCH_RE.test(name) && !name.includes("..") && !name.startsWith("/");
}

export interface GitToolOptions {
  cwd: string;
  exec?: ExecFn;
}

export function gitTools(opts: GitToolOptions): AgentTool[] {
  const cwd = opts.cwd;
  const exec = opts.exec ?? defaultExec;
  const git = (args: string[]): Promise<string> => exec("git", args, { cwd });

  const status: AgentTool = {
    name: "git_status",
    description: "Show git status (short) and current branch inside the workspace.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      try {
        const [branch, status] = await Promise.all([git(["branch", "--show-current"]), git(["status", "--short"])]);
        return { ok: true, output: `branch: ${branch}\n${status.length > 0 ? status : "(clean)"}` };
      } catch (err) {
        return { ok: false, output: `git status failed: ${errorMessage(err)}` };
      }
    },
  };

  const branch: AgentTool = {
    name: "git_branch",
    description: "Create/switch to a git branch. Protected branches (main, master) are refused.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Branch name, e.g. agent/ticket-7" } },
      required: ["name"],
    },
    async run(args) {
      const name = args.name;
      if (typeof name !== "string" || !isValidBranchName(name)) {
        return { ok: false, output: `invalid branch name: ${String(name)}` };
      }
      if (isProtectedBranch(name)) {
        return { ok: false, output: `refusing to switch to protected branch: ${name}` };
      }
      try {
        await git(["checkout", "-B", name]);
        return { ok: true, output: `on branch ${name}` };
      } catch (err) {
        return { ok: false, output: `git branch failed: ${errorMessage(err)}` };
      }
    },
  };

  const commit: AgentTool = {
    name: "git_commit",
    description: "Stage all workspace changes and commit with a message. Returns the short hash.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Commit message" } },
      required: ["message"],
    },
    async run(args) {
      const message = args.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        return { ok: false, output: "message is required" };
      }
      try {
        await git(["add", "-A", "."]);
        await git(["commit", "-m", message.trim()]);
        const hash = (await git(["rev-parse", "--short", "HEAD"])).trim();
        return { ok: true, output: `committed ${hash}: ${message.trim()}` };
      } catch (err) {
        return { ok: false, output: `git commit failed: ${errorMessage(err)}` };
      }
    },
  };

  const push: AgentTool = {
    name: "git_push",
    description:
      "Push the current (non-protected) branch to origin. main/master and force pushes are refused.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      try {
        const branch = (await git(["branch", "--show-current"])).trim();
        if (isProtectedBranch(branch)) {
          return { ok: false, output: `refusing to push protected branch: ${branch}` };
        }
        await git(["push", "-u", "origin", branch]);
        return { ok: true, output: `pushed ${branch} to origin` };
      } catch (err) {
        return { ok: false, output: `git push failed: ${errorMessage(err)}` };
      }
    },
  };

  return [status, branch, commit, push];
}
