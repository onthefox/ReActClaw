import test from "node:test";
import assert from "node:assert/strict";
import { runLoop, type AgentTool, type ToolResult } from "../src/core/loop.js";
import type { ChatMessage, ToolSpec } from "../src/core/llm.js";

class FakeLlm {
  queue: ChatMessage[] = [];
  calls: ChatMessage[][] = [];

  async chat(messages: ChatMessage[], _tools: ToolSpec[]): Promise<ChatMessage> {
    this.calls.push([...messages]);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLlm queue empty");
    return next;
  }
}

const echoTool: AgentTool = {
  name: "echo",
  description: "echoes its input",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async run(args): Promise<ToolResult> {
    return { ok: true, output: `echo:${String(args.text ?? "")}` };
  },
};

test("loop runs a tool call, observes, then finishes", async () => {
  const llm = new FakeLlm();
  llm.queue.push(
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
    },
    { role: "assistant", content: "all done" },
  );
  const kinds: string[] = [];

  const result = await runLoop({
    llm,
    tools: [echoTool],
    system: "sys",
    task: "do it",
    maxSteps: 4,
    deadlineMs: 5_000,
    trace: (entry) => kinds.push(entry.kind),
  });

  assert.equal(result.status, "done");
  assert.equal(result.finalMessage, "all done");
  assert.equal(result.steps, 2);
  assert.deepEqual(kinds, ["assistant", "tool_result", "final"]);

  const secondCall = llm.calls[1];
  assert.ok(secondCall);
  const toolMsg = secondCall.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.equal(toolMsg.tool_call_id, "t1");
  assert.equal(toolMsg.content, "echo:hi");
});

class ToolCallLlm {
  calls = 0;
  async chat(_messages: ChatMessage[], _tools: ToolSpec[]): Promise<ChatMessage> {
    this.calls += 1;
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: `t${this.calls}`, type: "function", function: { name: "echo", arguments: '{"text":"x"}' } }],
    };
  }
}

test("loop stops when the step budget is exhausted", async () => {
  const llm = new ToolCallLlm();

  const result = await runLoop({
    llm,
    tools: [echoTool],
    system: "sys",
    task: "loop forever",
    maxSteps: 3,
    deadlineMs: 60_000,
  });

  assert.equal(result.status, "budget_exhausted");
  assert.match(result.finalMessage, /step budget exhausted \(3\)/);
  assert.equal(result.steps, 3);
});

test("loop survives invalid arguments and unknown tools, then finishes", async () => {
  const llm = new FakeLlm();
  llm.queue.push(
    { role: "assistant", content: null, tool_calls: [{ id: "t2", type: "function", function: { name: "echo", arguments: "not json" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "t3", type: "function", function: { name: "nope", arguments: "{}" } }] },
    { role: "assistant", content: "recovered" },
  );

  const result = await runLoop({
    llm,
    tools: [echoTool],
    system: "s",
    task: "t",
    maxSteps: 5,
    deadlineMs: 5_000,
  });

  assert.equal(result.status, "done");
  assert.equal(result.finalMessage, "recovered");
  const toolMsgs = result.transcript.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.match(toolMsgs[0]?.content ?? "", /invalid tool arguments/);
  assert.match(toolMsgs[1]?.content ?? "", /unknown tool/);
});

test("loop reports an llm error as llm_error", async () => {
  const llm = new FakeLlm();
  const result = await runLoop({
    llm,
    tools: [echoTool],
    system: "s",
    task: "t",
    maxSteps: 2,
    deadlineMs: 5_000,
  });
  assert.equal(result.status, "llm_error");
  assert.match(result.finalMessage, /LLM error/);
});
