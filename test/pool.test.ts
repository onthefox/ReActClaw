import test from "node:test";
import assert from "node:assert/strict";
import { FreePoolRouter, PoolExhaustedError, type PoolEntry } from "../src/core/pool.js";
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
