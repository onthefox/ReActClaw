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

interface CliArgs {
  task: string | null;
  workspace: string;
}

function parseArgs(argv: string[]): CliArgs {
  let task: string | null = null;
  let workspace = "workspace";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--task") {
      task = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--workspace") {
      workspace = argv[i + 1] ?? workspace;
      i += 1;
    } else if (task === null && !arg.startsWith("--")) {
      task = arg;
    }
  }
  return { task, workspace };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.task === null || args.task.trim().length === 0) {
    console.error('usage: npm run agent -- --task "do something" [--workspace dir]');
    return 2;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
