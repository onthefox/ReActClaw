import type { ChatMessage, ToolSpec } from "./llm.js";
import type { ChatFn } from "./loop.js";

export interface PoolEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
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
    model: "deepseek-v4-flash-free",
  },
];

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
    private readonly entries: PoolEntry[] = DEFAULT_POOL,
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

  private async callEntry(
    entry: PoolEntry,
    messages: ChatMessage[],
    tools: ToolSpec[],
  ): Promise<ChatMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (entry.apiKey && entry.apiKey !== "none") headers.authorization = `Bearer ${entry.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: entry.model,
          temperature: 0.2,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err);
      throw new Error(`network failure — ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    let body: ChatCompletionResponse;
    try {
      body = JSON.parse(bodyText) as ChatCompletionResponse;
    } catch {
      throw new Error("non-JSON body");
    }
    const choice = body.choices?.[0]?.message;
    if (!choice) throw new Error("response has no choices[0].message");
    return {
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: (choice.tool_calls as ChatMessage["tool_calls"]) ?? undefined,
    };
  }
}
