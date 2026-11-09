import test from "node:test";
import assert from "node:assert/strict";
import { FreePoolRouter, PoolExhaustedError, defaultPoolFromEnv, type PoolEntry } from "../src/core/pool.js";
import type { ChatMessage, ToolSpec } from "../src/core/llm.js";

function okBody(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

function makeFetch(
  behavior: (url: string) => { status: number; body?: string; fail?: Error },
  calls: string[] = [],
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const b = behavior(url);
    if (b.fail) throw b.fail;
    return new Response(b.body ?? "", { status: b.status });
  }) as typeof fetch;
}

const entries: PoolEntry[] = [
  { name: "a", baseUrl: "https://a.test/v1", apiKey: "none", model: "m-a" },
  { name: "b", baseUrl: "https://b.test/v1", apiKey: "public", model: "m-b" },
];
const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
const tools: ToolSpec[] = [];

test("pool falls over to the next entry on 429 and cools down the first", async () => {
  const calls: string[] = [];
  const fetchFn = makeFetch(
    (url) => (url.startsWith("https://a.test") ? { status: 429, body: "rate limited" } : { status: 200, body: okBody("from-b") }),
    calls,
  );
  const router = new FreePoolRouter(entries, fetchFn);
  const reply = await router.chat(messages, tools);
  assert.equal(reply.content, "from-b");
  assert.equal(calls.length, 2);

  const status = router.status();
  assert.equal(status[0]?.healthy, false);
  assert.match(status[0]?.lastError ?? "", /429/);
  assert.equal(status[1]?.healthy, true);
});

test("pool throws PoolExhaustedError when every entry fails", async () => {
  const fetchFn = makeFetch(() => ({ status: 500, body: "boom" }));
  const router = new FreePoolRouter(entries, fetchFn);
  await assert.rejects(() => router.chat(messages, tools), PoolExhaustedError);
  assert.equal(router.healthyEntries().length, 0);
});

test("pool returns from the first healthy entry without touching others", async () => {
  const calls: string[] = [];
  const fetchFn = makeFetch(() => ({ status: 200, body: okBody("ok-a") }), calls);
  const router = new FreePoolRouter(entries, fetchFn);
  const reply = await router.chat(messages, tools);
  assert.equal(reply.content, "ok-a");
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /a\.test\/v1\/chat\/completions/);
});

test("pool recovers an entry after its cooldown expires", async () => {
  const calls: string[] = [];
  let aUp = false;
  const fetchFn = makeFetch(
    (url) => (url.startsWith("https://a.test") && !aUp ? { status: 500, body: "down" } : { status: 200, body: okBody("up") }),
    calls,
  );
  const router = new FreePoolRouter(entries, fetchFn);
  await router.chat(messages, tools);
  assert.equal(router.healthyEntries().length, 1);

  const state = router.status().find((s) => s.name === "a");
  assert.ok(state);
  aUp = true;
  const cooldown = (router as unknown as { states: Map<string, { cooldownUntil: number }> }).states
    .get("a");
  assert.ok(cooldown);
  cooldown.cooldownUntil = Date.now() - 1;

  const reply = await router.chat(messages, tools);
  assert.equal(reply.content, "up");
});

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function makeRecordingFetch(
  handler: (url: string, body: Record<string, unknown>) => { status: number; body: string },
): { fetchFn: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    requests.push({ url, body: parsed, headers });
    const r = handler(url, parsed);
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return { fetchFn, requests };
}

test("azure entry posts the deployment name to the unified v1 path with api-key", async () => {
  const { fetchFn, requests } = makeRecordingFetch(() => ({ status: 200, body: okBody("from-azure") }));
  const azureEntry: PoolEntry = {
    name: "azure",
    baseUrl: "https://res.openai.azure.com/openai/v1",
    apiKey: "az-key",
    model: "gpt-5",
    api: "azure-openai",
    deploymentName: "gpt5-prod",
  };
  const router = new FreePoolRouter([azureEntry], fetchFn);
  const reply = await router.chat(messages, tools);
  assert.equal(reply.content, "from-azure");

  const req = requests[0];
  assert.ok(req);
  assert.match(req.url, /https:\/\/res\.openai\.azure\.com\/openai\/v1\/chat\/completions\?api-version=v1/);
  assert.equal(req.body.model, "gpt5-prod");
  assert.equal(req.headers["api-key"], "az-key");
  assert.equal(req.headers.authorization, "Bearer az-key");
});

test("anthropic entry maps messages, tools and tool_use replies onto ChatMessage", async () => {
  const { fetchFn, requests } = makeRecordingFetch(() => ({
    status: 200,
    body: JSON.stringify({ content: [{ type: "tool_use", id: "tu_1", name: "shell", input: { command: "dir" } }] }),
  }));
  const cc: PoolEntry = { name: "cc", baseUrl: "https://cc.test/anthropic", apiKey: "cc-key", model: "cc-model", api: "anthropic" };
  const router = new FreePoolRouter([cc], fetchFn);
  const thread: ChatMessage[] = [
    { role: "system", content: "be brief" },
    { role: "user", content: "run it" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } }] },
    { role: "tool", content: "file.txt", tool_call_id: "call_1" },
  ];
  const toolSpecs: ToolSpec[] = [{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object" } } }];
  const reply = await router.chat(thread, toolSpecs);
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content, null);
  assert.equal(reply.tool_calls?.[0]?.id, "tu_1");
  assert.equal(reply.tool_calls?.[0]?.function.name, "shell");
  assert.equal(reply.tool_calls?.[0]?.function.arguments, '{"command":"dir"}');

  const req = requests[0];
  assert.ok(req);
  assert.match(req.url, /cc\.test\/anthropic\/v1\/messages/);
  assert.equal(req.headers["x-api-key"], "cc-key");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.body.model, "cc-model");
  assert.equal(req.body.system, "be brief");
  assert.ok(Array.isArray(req.body.tools));
  const sent = req.body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
  assert.equal(sent.length, 3);
  assert.equal(sent[0]?.role, "user");
  assert.equal(sent[0]?.content[0]?.type, "text");
  assert.equal(sent[1]?.role, "assistant");
  assert.equal(sent[1]?.content[0]?.type, "tool_use");
  assert.equal(sent[2]?.role, "user");
  assert.equal(sent[2]?.content[0]?.type, "tool_result");
});

test("pool mixes openai and anthropic entries on failover", async () => {
  const { fetchFn } = makeRecordingFetch((url) =>
    url.startsWith("https://a.test")
      ? { status: 500, body: "down" }
      : { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "from-cc" }] }) },
  );
  const mixed: PoolEntry[] = [
    { name: "a", baseUrl: "https://a.test/v1", apiKey: "none", model: "m-a" },
    { name: "cc", baseUrl: "https://cc.test/anthropic", apiKey: "k", model: "m-cc", api: "anthropic" },
  ];
  const router = new FreePoolRouter(mixed, fetchFn);
  const reply = await router.chat(messages, tools);
  assert.equal(reply.content, "from-cc");
});

test("defaultPoolFromEnv appends azure and anthropic entries from env", () => {
  const pool = defaultPoolFromEnv({
    AZURE_OPENAI_API_KEY: "az",
    AZURE_OPENAI_BASE_URL: "https://myres.openai.azure.com/",
    AGENT_AZURE_MODEL: "gpt-5",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=gpt5-prod",
    AGENT_ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic/",
    AGENT_ANTHROPIC_API_KEY: "cc",
    AGENT_ANTHROPIC_MODEL: "deepseek-chat",
  });
  const az = pool.find((e) => e.name === "azure");
  assert.ok(az);
  assert.equal(az.baseUrl, "https://myres.openai.azure.com/openai/v1");
  assert.equal(az.api, "azure-openai");
  assert.equal(az.deploymentName, "gpt5-prod");
  const cc = pool.find((e) => e.name === "anthropic");
  assert.ok(cc);
  assert.equal(cc.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(cc.api, "anthropic");

  const bare = defaultPoolFromEnv({});
  assert.equal(bare.some((e) => e.name === "azure" || e.name === "anthropic"), false);
});
