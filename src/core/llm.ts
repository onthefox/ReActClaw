export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export const DEFAULT_OLLAMA_MODEL = "hf.co/unsloth/GLM-4.6V-Flash-GGUF:Q4_K_M";

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const baseUrl = (env.AGENT_BASE_URL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
  const apiKey = env.AGENT_API_KEY ?? "";
  const model = env.AGENT_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const temperature = Number(env.AGENT_TEMPERATURE ?? "0.2");
  return {
    baseUrl,
    apiKey,
    model,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
  };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
}

export class LlmClient {
  constructor(
    public readonly cfg: LlmConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey.length > 0) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await this.fetchFn(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: this.cfg.temperature,
        messages,
        tools,
      }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new LlmError(`LLM HTTP ${res.status}: ${bodyText.slice(0, 500)}`, res.status);
    }
    let body: ChatCompletionResponse;
    try {
      body = JSON.parse(bodyText) as ChatCompletionResponse;
    } catch {
      throw new LlmError("LLM returned a non-JSON body");
    }
    const choice = body.choices?.[0]?.message;
    if (!choice) throw new LlmError("LLM response has no choices[0].message");
    return {
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: choice.tool_calls,
    };
  }
}
