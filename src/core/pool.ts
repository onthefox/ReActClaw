import type { ChatMessage, ToolSpec } from "./llm.js";
import type { ChatFn } from "./loop.js";

/** Wire protocol of a pool entry. */
export type PoolApi = "openai" | "azure-openai" | "anthropic";

export interface PoolEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Defaults to "openai" (POST {base}/chat/completions). */
  api?: PoolApi;
  /** Azure: deployment name sent as `model` when it differs from the catalog id. */
  deploymentName?: string;
}

export const DEFAULT_POOL: PoolEntry[] = [
  {
    name: "kilo",
    baseUrl: "https://ai-gateway.kilo.ai/api/v1",
    apiKey: "none",
    model: "kilo-auto/free",
  },
  {
    name: "pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    apiKey: "none",
    model: "openai",
  },
  {
    name: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "public",
    model: "deepseek-v4.1-flash-free",
  },
];

const AZURE_HOST_SUFFIXES = [".openai.azure.com", ".cognitiveservices.azure.com", ".ai.azure.com"];

function normalizeAzureBaseUrl(raw: string): string {
  const url = new URL(raw.trim().replace(/\/+$/, ""));
  if (AZURE_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s))) {
    const p = url.pathname.replace(/\/+$/, "");
    if (p === "" || p === "/" || p === "/openai") url.pathname = "/openai/v1";
  }
  return url.toString().replace(/\/+$/, "");
}

function azureBaseUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.AZURE_OPENAI_BASE_URL?.trim();
  if (explicit) return normalizeAzureBaseUrl(explicit);
  const resource = env.AZURE_OPENAI_RESOURCE_NAME?.trim();
  if (resource) return `https://${resource}.openai.azure.com/openai/v1`;
  return undefined;
}

function parseDeploymentMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    map.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return map;
}

/** Default pool plus optional BYOK entries built from the environment. */
export function defaultPoolFromEnv(env: Record<string, string | undefined> = process.env): PoolEntry[] {
  const pool = [...DEFAULT_POOL];
  const azureBase = azureBaseUrlFromEnv(env);
  const azureKey = env.AZURE_OPENAI_API_KEY?.trim();
  const azureModel = (env.AGENT_AZURE_MODEL ?? env.AZURE_OPENAI_MODEL)?.trim();
  if (azureBase && azureKey && azureModel) {
    const deployment = parseDeploymentMap(env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(azureModel);
    pool.push({ name: "azure", baseUrl: azureBase, apiKey: azureKey, model: azureModel, api: "azure-openai", deploymentName: deployment });
  }
  const ccBase = env.AGENT_ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "");
  const ccKey = env.AGENT_ANTHROPIC_API_KEY?.trim();
  const ccModel = env.AGENT_ANTHROPIC_MODEL?.trim();
  if (ccBase && ccKey && ccModel) {
    pool.push({ name: "anthropic", baseUrl: ccBase, apiKey: ccKey, model: ccModel, api: "anthropic" });
  }
  return pool;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content ?? "" }] });
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" }] });
      continue;
    }
    const blocks: AnthropicBlock[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const call of m.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function.arguments === "" ? "{}" : call.function.arguments);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // keep {} for unparseable arguments
      }
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
    out.push({ role: "assistant", content: blocks });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

function toAnthropicTools(tools: ToolSpec[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

interface AnthropicReply {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
}

function fromAnthropicReply(body: AnthropicReply): ChatMessage {
  if (!Array.isArray(body.content)) throw new Error("response has no content blocks");
  const text = body.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  const toolCalls = body.content
    .filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
    .map((b) => ({
      id: b.id as string,
      type: "function" as const,
      function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) },
    }));
  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

interface EntryState {
  cooldownUntil: number;
  failures: number;
  lastError: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
}

type FetchFn = typeof fetch;

const BASE_COOLDOWN_MS = 30_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

export class PoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolExhaustedError";
  }
}

export class FreePoolRouter implements ChatFn {
  private readonly states = new Map<string, EntryState>();

  constructor(
    private readonly entries: PoolEntry[] = defaultPoolFromEnv(),
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 90_000,
  ) {}

  private stateFor(entry: PoolEntry): EntryState {
    let state = this.states.get(entry.name);
    if (!state) {
      state = { cooldownUntil: 0, failures: 0, lastError: "" };
      this.states.set(entry.name, state);
    }
    return state;
  }

  private cooldown(state: EntryState, ms: number): void {
    state.failures += 1;
    const scaled = Math.min(ms * 2 ** Math.min(state.failures - 1, 4), MAX_COOLDOWN_MS);
    state.cooldownUntil = Date.now() + scaled;
  }

  healthyEntries(): PoolEntry[] {
    const now = Date.now();
    return this.entries.filter((e) => this.stateFor(e).cooldownUntil <= now);
  }

  status(): Array<{ name: string; healthy: boolean; failures: number; lastError: string }> {
    const now = Date.now();
    return this.entries.map((e) => {
      const s = this.stateFor(e);
      return { name: e.name, healthy: s.cooldownUntil <= now, failures: s.failures, lastError: s.lastError };
    });
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const candidates = this.healthyEntries();
    if (candidates.length === 0) {
      throw new PoolExhaustedError("all pool entries are cooling down");
    }
    const errors: string[] = [];
    for (const entry of candidates) {
      const state = this.stateFor(entry);
      try {
        return await this.callEntry(entry, messages, tools);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = message;
        errors.push(`${entry.name}: ${message}`);
        if (/\b429\b/.test(message)) {
          this.cooldown(state, RATE_LIMIT_COOLDOWN_MS);
        } else {
          this.cooldown(state, BASE_COOLDOWN_MS);
        }
      }
    }
    throw new PoolExhaustedError(`all pool entries failed — ${errors.join(" | ")}`);
  }

  private requestFor(entry: PoolEntry, messages: ChatMessage[], tools: ToolSpec[]): { url: string; body: string } {
    const base = entry.baseUrl.replace(/\/+$/, "");
    if (entry.api === "anthropic") {
      const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
      const converted = toAnthropicMessages(messages);
      const payload = {
        model: entry.model,
        max_tokens: 4096,
        temperature: 0.2,
        ...(converted.system ? { system: converted.system } : {}),
        messages: converted.messages,
        ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
      };
      return { url, body: JSON.stringify(payload) };
    }
    let url = `${base}/chat/completions`;
    if (entry.api === "azure-openai") {
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim() || "v1";
      url += `?api-version=${encodeURIComponent(apiVersion)}`;
    }
    const payload = {
      model: entry.deploymentName ?? entry.model,
      temperature: 0.2,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    };
    return { url, body: JSON.stringify(payload) };
  }

  private async callEntry(
    entry: PoolEntry,
    messages: ChatMessage[],
    tools: ToolSpec[],
  ): Promise<ChatMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (entry.apiKey && entry.apiKey !== "none") {
      if (entry.api === "anthropic") headers["x-api-key"] = entry.apiKey;
      if (entry.api !== "anthropic") headers.authorization = `Bearer ${entry.apiKey}`;
      if (entry.api === "azure-openai") headers["api-key"] = entry.apiKey;
    }
    if (entry.api === "anthropic") headers["anthropic-version"] = "2023-06-01";
    const { url, body } = this.requestFor(entry, messages, tools);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err);
      throw new Error(`network failure — ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error("non-JSON body");
    }
    if (entry.api === "anthropic") return fromAnthropicReply(parsed as AnthropicReply);
    const body2 = parsed as ChatCompletionResponse;
    const choice = body2.choices?.[0]?.message;
    if (!choice) throw new Error("response has no choices[0].message");
    return {
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: (choice.tool_calls as ChatMessage["tool_calls"]) ?? undefined,
    };
  }
}
