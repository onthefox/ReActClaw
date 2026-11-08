import type { ChatMessage, ToolCall, ToolSpec } from "./llm.js";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ChatFn {
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage>;
}

export interface TraceEntry {
  at: string;
  kind: "assistant" | "tool_result" | "final" | "budget";
  data: unknown;
}

export type TraceSink = (entry: TraceEntry) => void;

export interface LoopOptions {
  llm: ChatFn;
  tools: AgentTool[];
  system: string;
  task: string;
  maxSteps: number;
  deadlineMs: number;
  trace?: TraceSink;
}

export interface LoopResult {
  status: "done" | "budget_exhausted" | "llm_error";
  finalMessage: string;
  steps: number;
  transcript: ChatMessage[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function traceEntry(kind: TraceEntry["kind"], data: unknown): TraceEntry {
  return { at: new Date().toISOString(), kind, data };
}

async function executeCall(
  toolByName: Map<string, AgentTool>,
  call: ToolCall,
): Promise<ToolResult> {
  const tool = toolByName.get(call.function.name);
  if (!tool) return { ok: false, output: `unknown tool: ${call.function.name}` };
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments === "" ? "{}" : call.function.arguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, output: `invalid tool arguments: ${errorMessage(err)}` };
  }
  try {
    return await tool.run(args);
  } catch (err) {
    return { ok: false, output: `tool error: ${errorMessage(err)}` };
  }
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const trace = opts.trace ?? (() => {});
  const startedAt = Date.now();
  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
  const specs: ToolSpec[] = opts.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const transcript: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];
  let steps = 0;

  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (steps >= opts.maxSteps) {
      const reason = `step budget exhausted (${opts.maxSteps})`;
      trace(traceEntry("budget", { reason, steps }));
      return { status: "budget_exhausted", finalMessage: `Stopped: ${reason}.`, steps, transcript };
    }
    if (elapsed >= opts.deadlineMs) {
      const reason = `time budget exhausted (${Math.round(opts.deadlineMs / 1000)}s)`;
      trace(traceEntry("budget", { reason, steps }));
      return { status: "budget_exhausted", finalMessage: `Stopped: ${reason}.`, steps, transcript };
    }

    let reply: ChatMessage;
    try {
      reply = await opts.llm.chat(transcript, specs);
    } catch (err) {
      const reason = `LLM error — ${errorMessage(err)}`;
      trace(traceEntry("budget", { reason, steps }));
      return { status: "llm_error", finalMessage: `Stopped: ${reason}`, steps, transcript };
    }
    steps += 1;

    const toolCalls = reply.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const finalMessage = reply.content ?? "";
      transcript.push({ role: "assistant", content: finalMessage });
      trace(traceEntry("final", finalMessage));
      return { status: "done", finalMessage, steps, transcript };
    }

    transcript.push({ role: "assistant", content: reply.content ?? null, tool_calls: toolCalls });
    trace(traceEntry("assistant", { content: reply.content, tool_calls: toolCalls }));

    for (const call of toolCalls) {
      const result = await executeCall(toolByName, call);
      transcript.push({ role: "tool", content: result.output, tool_call_id: call.id });
      trace(traceEntry("tool_result", { tool: call.function.name, ok: result.ok, output: result.output }));
    }
  }
}
