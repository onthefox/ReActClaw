import { readFileSync } from "node:fs";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LlmClient, llmConfigFromEnv } from "./core/llm.js";
import { FreePoolRouter } from "./core/pool.js";
import { runLoop } from "./core/loop.js";
import { budgetFromEnv } from "./core/budget.js";
import { ToolRegistry } from "./tools/registry.js";
import { shellTool } from "./tools/shell.js";
import { filesTools } from "./tools/files.js";
import { runTicket } from "./run-ticket.js";

interface CliArgs {
  task: string | null;
  workspace: string;
  ticket: number | null;
  repo: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let task: string | null = null;
  let workspace: string | null = null;
  let ticket: number | null = null;
  let repo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--task") {
      task = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--workspace") {
      workspace = argv[i + 1] ?? workspace;
      i += 1;
    } else if (arg === "--ticket") {
      const n = Number(argv[i + 1]);
      ticket = Number.isInteger(n) && n > 0 ? n : null;
      i += 1;
    } else if (arg === "--repo") {
      repo = argv[i + 1] ?? null;
      i += 1;
    } else if (task === null && !arg.startsWith("--")) {
      task = arg;
    }
  }
  return { task, workspace: workspace ?? "workspace", ticket, repo };
}

export function parseOwnerRepo(remoteUrl: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (args.ticket !== null) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(execFile);
    let repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? null;
    if (repo === null) {
      try {
        const remote = (await execAsync("git", ["remote", "get-url", "origin"], { cwd: process.cwd() })).stdout;
        repo = parseOwnerRepo(remote);
      } catch {
        repo = null;
      }
    }
    if (repo === null) {
      console.error("usage: npm run agent -- --ticket N [--repo owner/name] (or GITHUB_REPOSITORY / origin remote)");
      return 2;
    }
    const workspace = path.resolve(args.workspace === "workspace" ? process.cwd() : args.workspace);
    await mkdir(workspace, { recursive: true });
    const runsDir = path.join(repoRoot, "runs");
    await mkdir(runsDir, { recursive: true });
    const traceFile = path.join(runsDir, `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    await writeFile(traceFile, "", "utf8");
    const usePool = process.env.AGENT_BASE_URL === undefined && process.env.AGENT_ROUTER !== "direct";
    const router = new FreePoolRouter();
    const direct = new LlmClient(llmConfigFromEnv());
    const llm = usePool ? router : direct;
    console.error(`[agent] ticket=${args.ticket} repo=${repo} workspace=${workspace}`);
    const outcome = await runTicket({
      repo,
      ticket: args.ticket,
      workspace,
      outboxFile: path.join(runsDir, `outbox-ticket-${args.ticket}.jsonl`),
      traceFile,
      system: readFileSync(path.join(repoRoot, "prompts", "system.md"), "utf8"),
      llm,
      budget: budgetFromEnv(),
      allowlistRaw: process.env.AGENT_ACTOR_ALLOWLIST,
      agentLogin: process.env.GITHUB_ACTOR,
    });
    if (!outcome.ran) {
      console.error(`[agent] skipped: ${outcome.skipReason ?? outcome.error}`);
      return outcome.error === undefined ? 0 : 1;
    }
    console.log(outcome.finalMessage ?? "");
    console.error(
      `[agent] status=${outcome.loopStatus} state=${outcome.ticketState} pr=${outcome.prUrl ?? "none"} outbox=${JSON.stringify(outcome.flush)}`,
    );
    return outcome.loopStatus === "done" ? 0 : 1;
  }

  if (args.task === null || args.task.trim().length === 0) {
    console.error('usage: npm run agent -- --task "do something" [--workspace dir] | --ticket N [--repo owner/name] [--workspace dir]');
    return 2;
  }

  const workspace = path.resolve(args.workspace);
  await mkdir(workspace, { recursive: true });
  const runsDir = path.join(repoRoot, "runs");
  await mkdir(runsDir, { recursive: true });

  const registry = new ToolRegistry().add(
    shellTool({ cwd: workspace }),
    ...filesTools({ root: workspace }),
  );
  const system = readFileSync(path.join(repoRoot, "prompts", "system.md"), "utf8");
  const budget = budgetFromEnv();
  const usePool = process.env.AGENT_BASE_URL === undefined && process.env.AGENT_ROUTER !== "direct";
  const router = new FreePoolRouter();
  const direct = new LlmClient(llmConfigFromEnv());
  const llm = usePool ? router : direct;

  const traceFile = path.join(runsDir, `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await writeFile(traceFile, "", "utf8");

  console.error(`[agent] router=${usePool ? `pool(${router.status().map((s) => s.name).join("|")})` : `direct(${direct.cfg.baseUrl})`}`);
  console.error(`[agent] workspace=${workspace}`);
  console.error(`[agent] trace=${traceFile}`);

  const result = await runLoop({
    llm,
    tools: registry.list(),
    system,
    task: args.task,
    maxSteps: budget.maxSteps,
    deadlineMs: budget.maxMs,
    trace: (entry) => {
      void appendFile(traceFile, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
    },
  });

  console.log(result.finalMessage);
  console.error(`[agent] status=${result.status} steps=${result.steps}`);
  return result.status === "done" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
