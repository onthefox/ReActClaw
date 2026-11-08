import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import type { AgentTool, ToolResult } from "../core/loop.js";

export interface ShellToolOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

const DENYLIST: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*[rf][a-zA-Z]*\b/i, reason: "recursive forced delete (rm -rf)" },
  { pattern: /remove-item\s+[^;\n]*-recurse[^;\n]*-force/i, reason: "Remove-Item -Recurse -Force" },
  { pattern: /\bdel\s+\/[fsq][fsq]*\s+\/[sq]\b/i, reason: "del with /f /s /q" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "format drive" },
  { pattern: /\bdiskpart\b/i, reason: "diskpart" },
  { pattern: /\b(shutdown|reboot)\b/i, reason: "shutdown/reboot" },
  { pattern: /\bdd\s+if=/i, reason: "dd raw write" },
  { pattern: /\bmkfs\b/i, reason: "mkfs" },
  { pattern: /\bgit\s+push\s+(-f\b|--force\b)/i, reason: "git push --force" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "git clean -f" },
  { pattern: /\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "piping into a shell" },
  { pattern: /\binvoke-expression\b|\biex\b/i, reason: "Invoke-Expression" },
  { pattern: /\bcurl\b[^;\n]*\|\s*(ba)?sh\b/i, reason: "curl piped into a shell" },
];

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
}

const KILL_SETTLE_MS = 10_000;

function collect(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  maxBytes: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killWatch: NodeJS.Timeout | undefined;

    const append = (chunk: string | Buffer): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (out.length >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - out.length;
      if (buf.length > room) truncated = true;
      out = Buffer.concat([out, buf.subarray(0, room)]);
    };
    const text = (): string => {
      const s = out.toString("utf8");
      return truncated ? `${s}\n...output truncated...` : s;
    };
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (killWatch !== undefined) clearTimeout(killWatch);
      resolve(result);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      killWatch = setTimeout(
        () => finish({ ok: false, output: `command timed out after ${timeoutMs} ms\n${text()}` }),
        KILL_SETTLE_MS,
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, output: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(
        timedOut
          ? { ok: false, output: `command timed out after ${timeoutMs} ms\n${text()}` }
          : { ok: code === 0, output: `exit code: ${code ?? "signal"}\n${text()}` },
      );
    });
  });
}

export function shellTool(opts: ShellToolOptions): AgentTool {
  const cwd = path.resolve(opts.cwd);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    name: "shell",
    description:
      "Run a shell command inside the workspace directory (cmd.exe on Windows, /bin/sh on POSIX). " +
      "Dangerous commands are blocked by a denylist; output is capped; the process is killed at the timeout.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command line to run" } },
      required: ["command"],
    },
    async run(args) {
      const command = args.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, output: "command is required" };
      }
      for (const { pattern, reason } of DENYLIST) {
        if (pattern.test(command)) {
          return { ok: false, output: `blocked by denylist: ${reason}` };
        }
      }
      const child =
        process.platform === "win32"
          ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true })
          : spawn("/bin/sh", ["-c", command], { cwd });
      return collect(child, timeoutMs, maxOutputBytes);
    },
  };
}
