/**
 * Gateway inventory: enumerate candidate LLM endpoints (pool + BYOK + local),
 * probe their /models listing, and verify live chat where credentials allow.
 *
 * Mapped from the provider registry of piclaw-bot/pi (42 providers): only
 * OpenAI-compatible HTTP endpoints are actionable for our ChatFn, so those are
 * probed; protocol/OAuth-only providers are listed as notes at the end.
 *
 * Usage: npx tsx scripts/inventory-gateways.ts
 * Never prints key values; env vars are used by presence only.
 */

type Auth =
  | { kind: "none" }
  | { kind: "fixed"; key: string }
  | { kind: "env"; names: string[] };

interface Gateway {
  name: string;
  pi: string;
  baseUrl: string;
  group: "pool" | "byok" | "local";
  chatModel?: string;
  auth: Auth;
  note?: string;
  /** Anthropic Messages API (Claude Code compatible): base whose /v1/messages accepts the protocol. */
  anthropic?: { baseUrl: string; model: string };
  /** Azure OpenAI chat-only probe (deployment name; base URL + key from env). */
  azure?: { model: string };
}

const GATEWAYS: Gateway[] = [
  { name: "kilo", pi: "-", baseUrl: "https://ai-gateway.kilo.ai/api/v1", group: "pool", chatModel: "kilo-auto/free", auth: { kind: "none" }, note: "not in pi; our pool default" },
  { name: "pollinations", pi: "-", baseUrl: "https://text.pollinations.ai/openai", group: "pool", chatModel: "openai", auth: { kind: "none" }, note: "not in pi; single anonymous model" },
  { name: "opencode", pi: "opencode", baseUrl: "https://opencode.ai/zen/v1", group: "pool", chatModel: "deepseek-v4.1-flash-free", auth: { kind: "fixed", key: "public" }, note: "old model name deepseek-v4-flash-free is gone (HTTP 400)", anthropic: { baseUrl: "https://opencode.ai/zen", model: "claude-sonnet-4-5" } },
  { name: "openrouter", pi: "openrouter", baseUrl: "https://openrouter.ai/api/v1", group: "byok", chatModel: "openrouter/auto", auth: { kind: "env", names: ["OPENROUTER_API_KEY"] }, anthropic: { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" } },
  { name: "groq", pi: "groq", baseUrl: "https://api.groq.com/openai/v1", group: "byok", auth: { kind: "env", names: ["GROQ_API_KEY"] } },
  { name: "cerebras", pi: "cerebras", baseUrl: "https://api.cerebras.ai/v1", group: "byok", auth: { kind: "env", names: ["CEREBRAS_API_KEY"] } },
  { name: "together", pi: "together", baseUrl: "https://api.together.xyz/v1", group: "byok", auth: { kind: "env", names: ["TOGETHER_API_KEY"] } },
  { name: "fireworks", pi: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", group: "byok", auth: { kind: "env", names: ["FIREWORKS_API_KEY"] } },
  { name: "nvidia", pi: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", group: "byok", auth: { kind: "env", names: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"] } },
  { name: "mistral", pi: "mistral", baseUrl: "https://api.mistral.ai/v1", group: "byok", auth: { kind: "env", names: ["MISTRAL_API_KEY"] } },
  { name: "deepseek", pi: "deepseek", baseUrl: "https://api.deepseek.com/v1", group: "byok", auth: { kind: "env", names: ["DEEPSEEK_API_KEY"] }, anthropic: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-chat" } },
  { name: "xai", pi: "xai", baseUrl: "https://api.x.ai/v1", group: "byok", auth: { kind: "env", names: ["XAI_API_KEY"] } },
  { name: "google", pi: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", group: "byok", auth: { kind: "env", names: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] } },
  { name: "huggingface", pi: "huggingface", baseUrl: "https://router.huggingface.co/v1", group: "byok", auth: { kind: "env", names: ["HF_TOKEN", "HUGGINGFACE_API_KEY"] } },
  { name: "vercel-ai-gateway", pi: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", group: "byok", auth: { kind: "env", names: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"] } },
  { name: "moonshotai", pi: "moonshotai", baseUrl: "https://api.moonshot.ai/v1", group: "byok", auth: { kind: "env", names: ["MOONSHOT_API_KEY", "MOONSHOTAI_API_KEY"] }, anthropic: { baseUrl: "https://api.moonshot.ai/anthropic", model: "kimi-k3.1-pro" } },
  { name: "zai", pi: "zai", baseUrl: "https://api.z.ai/api/paas/v4", group: "byok", auth: { kind: "env", names: ["ZAI_API_KEY", "Z_AI_API_KEY"] }, anthropic: { baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.3" } },
  { name: "minimax", pi: "minimax", baseUrl: "https://api.minimax.io/v1", group: "byok", auth: { kind: "env", names: ["MINIMAX_API_KEY"] }, anthropic: { baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3.1" } },
  { name: "azure-openai", pi: "azure", baseUrl: "https://placeholder.openai.azure.com/openai/v1", group: "byok", auth: { kind: "env", names: ["AZURE_OPENAI_API_KEY"] }, azure: { model: "gpt-4o-mini" }, note: "chat-only probe; /models may 404 on locked-down resources" },
  { name: "ollama", pi: "-", baseUrl: "http://localhost:11434/v1", group: "local", auth: { kind: "none" }, note: "our direct-mode default" },
  { name: "lmstudio", pi: "-", baseUrl: "http://localhost:1234/v1", group: "local", auth: { kind: "none" } },
];

const NOT_AUTOMATABLE: string[] = [
  "anthropic, google-native, google-vertex, amazon-bedrock — native protocols, not OpenAI-compatible (azure covered by the azapi chat probe)",
  "github-copilot, openai-codex, qwen/xiaomi/zai token-plans, kimi-coding — OAuth device/token flows",
  "cloudflare-ai-gateway, cloudflare-workers-ai — account-scoped configuration",
  "opencode-go — same zen infra as opencode, multi-API; covered by the opencode probe",
  "typesafe — classifier-only; faux — test mock; radius — dynamic OAuth gateway",
  "meta, ant-ling, minimax-cn, moonshotai-cn, zai-coding-cn, xiaomi — regional/direct variants of probed groups",
];

const MODELS_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 25_000;
const FREE_RE = /(:free\b|-free\b)/i;

function authHeaders(g: Gateway): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (g.auth.kind === "fixed") headers.authorization = `Bearer ${g.auth.key}`;
  if (g.auth.kind === "env") {
    const name = g.auth.names.find((n) => (process.env[n] ?? "").length > 0);
    if (name !== undefined) headers.authorization = `Bearer ${process.env[name]}`;
  }
  return headers;
}

function hasCredentials(g: Gateway): boolean {
  if (g.auth.kind === "none" || g.auth.kind === "fixed") return true;
  return g.auth.names.some((n) => (process.env[n] ?? "").length > 0);
}

function envNames(g: Gateway): string {
  return g.auth.kind === "env" ? g.auth.names.join("|") : "-";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface ModelProbe {
  status: string;
  detail: string;
  freeCount: number;
  freeSample: string;
}

async function probeModels(g: Gateway): Promise<ModelProbe> {
  try {
    const res = await fetchWithTimeout(`${g.baseUrl.replace(/\/+$/, "")}/models`, { headers: authHeaders(g) }, MODELS_TIMEOUT_MS);
    if (!res.ok) {
      return { status: res.status === 401 || res.status === 403 ? "NOAUTH" : "FAIL", detail: `HTTP ${res.status}`, freeCount: 0, freeSample: "" };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
    const items = Array.isArray(body) ? body : body.data ?? [];
    const ids = items.map((m) => m.id ?? "").filter((s) => s.length > 0);
    const free = ids.filter((id) => FREE_RE.test(id));
    return {
      status: "OK",
      detail: `${ids.length} models`,
      freeCount: free.length,
      freeSample: free.slice(0, 6).join(", "),
    };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err instanceof Error ? err.message : err);
    return { status: "DOWN", detail: msg, freeCount: 0, freeSample: "" };
  }
}

interface ChatProbe {
  status: string;
  detail: string;
  ms: number;
}

async function probeChat(g: Gateway): Promise<ChatProbe | null> {
  if (g.chatModel === undefined) return null;
  if (!hasCredentials(g)) return { status: "SKIP", detail: `no ${envNames(g)}`, ms: 0 };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${g.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: authHeaders(g),
        body: JSON.stringify({
          model: g.chatModel,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 10,
        }),
      },
      CHAT_TIMEOUT_MS,
    );
    const ms = Date.now() - started;
    if (res.status === 429) return { status: "THROTTLED", detail: "HTTP 429", ms };
    if (!res.ok) {
      const text = (await res.text()).slice(0, 90).replace(/\s+/g, " ");
      return { status: res.status === 401 || res.status === 403 ? "AUTHFAIL" : "FAIL", detail: `HTTP ${res.status} ${text}`, ms };
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = body.choices?.[0]?.message?.content?.trim().slice(0, 40) ?? "(empty)";
    return { status: "OK", detail: `reply="${content}"`, ms };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err instanceof Error ? err.message : err);
    return { status: "DOWN", detail: msg, ms: Date.now() - started };
  }
}

/**
 * Azure OpenAI chat-only probe (docs/azure-access-architecture.md): POST
 * {base}/chat/completions?api-version=v1 with api-key + Bearer. /models is
 * deliberately not trusted — it may 404 on locked-down resources.
 * 200 = LIVE, 401/403 = endpoint exists, needs key.
 */
async function probeAzure(g: Gateway): Promise<ChatProbe | null> {
  if (g.azure === undefined) return null;
  const key = process.env.AZURE_OPENAI_API_KEY ?? "";
  if (key.length === 0) return { status: "SKIP", detail: "no AZURE_OPENAI_API_KEY", ms: 0 };
  const base =
    process.env.AZURE_OPENAI_BASE_URL ??
    (process.env.AZURE_OPENAI_RESOURCE_NAME
      ? `https://${process.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`
      : null);
  if (base === null) return { status: "SKIP", detail: "no AZURE_OPENAI_BASE_URL/RESOURCE_NAME", ms: 0 };
  const model = process.env.AZURE_OPENAI_MODEL ?? process.env.AGENT_AZURE_MODEL ?? g.azure.model;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "v1";
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${base.replace(/\/+$/, "")}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": key, authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 10,
        }),
      },
      CHAT_TIMEOUT_MS,
    );
    const ms = Date.now() - started;
    if (res.status === 401 || res.status === 403) return { status: "EXISTS", detail: "needs valid key", ms };
    if (res.status === 429) return { status: "THROTTLED", detail: "HTTP 429", ms };
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = body.choices?.[0]?.message?.content?.trim().slice(0, 40) ?? "(empty)";
      return { status: "LIVE", detail: `reply="${content}"`, ms };
    }
    const text = (await res.text()).slice(0, 90).replace(/\s+/g, " ");
    return { status: "FAIL", detail: `HTTP ${res.status} ${text}`, ms };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err instanceof Error ? err.message : err);
    return { status: "DOWN", detail: msg, ms: Date.now() - started };
  }
}

/** Anthropic Messages API probe. 200 = LIVE, 401/403 = endpoint exists, needs key; 404 = absent. */
async function probeAnthropic(g: Gateway): Promise<ChatProbe | null> {
  if (g.anthropic === undefined) return null;
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${g.anthropic.baseUrl.replace(/\/+$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...authHeaders(g) },
        body: JSON.stringify({
          model: g.anthropic.model,
          max_tokens: 8,
          messages: [{ role: "user", content: "OK" }],
        }),
      },
      CHAT_TIMEOUT_MS,
    );
    const ms = Date.now() - started;
    if (res.status === 401 || res.status === 403) return { status: "EXISTS", detail: "needs key", ms };
    if (res.status === 429) return { status: "THROTTLED", detail: "HTTP 429", ms };
    if (res.ok) {
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = body.content?.map((c) => c.text ?? "").join("").trim().slice(0, 40) ?? "(empty)";
      return { status: "LIVE", detail: `reply="${text}"`, ms };
    }
    const text = (await res.text()).slice(0, 90).replace(/\s+/g, " ");
    return { status: "FAIL", detail: `HTTP ${res.status} ${text}`, ms };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err instanceof Error ? err.message : err);
    return { status: "DOWN", detail: msg, ms: Date.now() - started };
  }
}

async function main(): Promise<void> {
  console.log(`[inventory] probing ${GATEWAYS.length} gateways (${new Date().toISOString()})`);
  console.log(
    "gateway".padEnd(19),
    "group".padEnd(6),
    "models".padEnd(22),
    "chat".padEnd(11),
    "azapi".padEnd(11),
    "ccapi".padEnd(11),
    "detail",
  );
  const alive = { pool: 0, byok: 0, local: 0 };
  let ccEndpoints = 0;
  let azEndpoints = 0;
  for (const g of GATEWAYS) {
    const models = await probeModels(g);
    const chat = await probeChat(g);
    const az = await probeAzure(g);
    const cc = await probeAnthropic(g);
    const chatCell = chat === null ? "-" : chat.status;
    const azCell = az === null ? "-" : az.status;
    const ccCell = cc === null ? "-" : cc.status;
    if (cc !== null && (cc.status === "LIVE" || cc.status === "EXISTS" || cc.status === "THROTTLED")) ccEndpoints += 1;
    if (az !== null && (az.status === "LIVE" || az.status === "EXISTS" || az.status === "THROTTLED")) azEndpoints += 1;
    const detail = [
      g.note ?? "",
      models.detail,
      models.freeCount > 0 ? `free=${models.freeCount}${models.freeSample ? ` [${models.freeSample}]` : ""}` : "",
      chat === null ? "" : chat.detail,
      az === null ? "" : az.detail,
      cc === null ? "" : cc.detail,
    ]
      .filter((s) => s.length > 0)
      .join(" | ");
    console.log(
      g.name.padEnd(19),
      g.group.padEnd(6),
      `${models.status}(${models.detail})`.padEnd(22),
      chatCell.padEnd(11),
      azCell.padEnd(11),
      ccCell.padEnd(11),
      detail,
    );
    if (models.status === "OK") alive[g.group] += 1;
  }
  console.log("");
  console.log(`[inventory] reachable /models: pool=${alive.pool} byok=${alive.byok} local=${alive.local}`);
  console.log(`[inventory] azure chat endpoints (api-key + api-version): ${azEndpoints}`);
  console.log(`[inventory] claude-code compatible (anthropic /v1/messages) endpoints: ${ccEndpoints}`);
  console.log("[inventory] not automatable here (protocol/OAuth/account-scoped):");
  for (const line of NOT_AUTOMATABLE) console.log(`  - ${line}`);
}

main().catch((err) => {
  console.error("[inventory] fatal:", err);
  process.exitCode = 1;
});
