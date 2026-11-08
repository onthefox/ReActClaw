import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolResult } from "../core/loop.js";

export interface FilesToolOptions {
  root: string;
}

const MAX_READ_BYTES = 512 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveWithin(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  return insideRoot(root, target) ? target : null;
}

export function filesTools(opts: FilesToolOptions): AgentTool[] {
  const root = path.resolve(opts.root);

  const listTool: AgentTool = {
    name: "files_list",
    description: "List files and directories under a workspace-relative path. Directories get a trailing slash.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative path, defaults to '.'" } },
      required: [],
    },
    async run(args) {
      const rel = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
      const target = resolveWithin(root, rel);
      if (target === null) return { ok: false, output: `path escapes workspace: ${rel}` };
      try {
        const entries = await fs.readdir(target, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { ok: true, output: lines.length > 0 ? lines.join("\n") : "(empty)" };
      } catch (err) {
        return { ok: false, output: `cannot list: ${errorMessage(err)}` };
      }
    },
  };

  const readTool: AgentTool = {
    name: "files_read",
    description: `Read a text file inside the workspace (limit ${MAX_READ_BYTES} bytes).`,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path" } },
      required: ["path"],
    },
    async run(args) {
      const rel = args.path;
      if (typeof rel !== "string" || rel.length === 0) return { ok: false, output: "path is required" };
      const target = resolveWithin(root, rel);
      if (target === null) return { ok: false, output: `path escapes workspace: ${rel}` };
      try {
        const stat = await fs.stat(target);
        if (stat.size > MAX_READ_BYTES) {
          return { ok: false, output: `file too large (${stat.size} bytes, limit ${MAX_READ_BYTES})` };
        }
        const content = await fs.readFile(target, "utf8");
        return { ok: true, output: content.length > 0 ? content : "(empty file)" };
      } catch (err) {
        return { ok: false, output: `cannot read: ${errorMessage(err)}` };
      }
    },
  };

  const writeTool: AgentTool = {
    name: "files_write",
    description: "Write a text file inside the workspace. Creates parent directories; overwrites an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
    async run(args) {
      const rel = args.path;
      const content = args.content;
      if (typeof rel !== "string" || rel.length === 0) return { ok: false, output: "path is required" };
      if (typeof content !== "string") return { ok: false, output: "content must be a string" };
      const target = resolveWithin(root, rel);
      if (target === null) return { ok: false, output: `path escapes workspace: ${rel}` };
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return { ok: true, output: `wrote ${rel} (${content.length} chars)` };
      } catch (err) {
        return { ok: false, output: `cannot write: ${errorMessage(err)}` };
      }
    },
  };

  return [listTool, readTool, writeTool];
}
