import type { ToolSpec } from "../core/llm.js";
import type { AgentTool } from "../core/loop.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  add(...tools: AgentTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`duplicate tool: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  toSpecs(): ToolSpec[] {
    return this.list().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
}
