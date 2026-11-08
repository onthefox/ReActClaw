# Azure access architecture

Findings from auditing the provider ecosystems around `piclaw-bot/pi`,
`rcarmo/piclaw` and `rcarmo/go-ai` (researched 2026-11-08). Azure access there is
organized in four layers: a protocol provider, a managed-identity extension, a
Go port, and deployment/ops documentation.

## 1. Protocol provider (pi: `packages/ai/src/providers/azure.ts`)

- Two dispatch APIs on one provider: `azure-openai-responses` (Responses API)
  and `openai-completions` (chat completions). Catalog also carries image and
  classifier models.
- Auth: static key via `AZURE_OPENAI_API_KEY` (Bearer).
- The deployment name, not the catalog model id, is sent as `model` in the
  request body. Mapping is per model id.

### URL resolution (`src/api/azure-openai-config.ts`)

Resolution order: option `azureBaseUrl` → env `AZURE_OPENAI_BASE_URL` → env
`AZURE_OPENAI_RESOURCE_NAME` → model's own `baseUrl`. A resource name builds
`https://{resource}.openai.azure.com/openai/v1`.

Normalization rules:

- Accepted host suffixes: `.openai.azure.com`, `.cognitiveservices.azure.com`,
  `.ai.azure.com`.
- For Azure hosts, the base path is forced to `/openai/v1` (the unified v1
  surface; SDK appends `/deployments/<name>/...` and `?api-version=v1`).
- Default API version: `v1` (env override: `AZURE_OPENAI_API_VERSION`).

### Environment variables

| Variable | Purpose |
|---|---|
| `AZURE_OPENAI_API_KEY` | Static Bearer key |
| `AZURE_OPENAI_BASE_URL` | Full endpoint base URL |
| `AZURE_OPENAI_RESOURCE_NAME` | Shorthand: builds `{name}.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_API_VERSION` | Override API version (default `v1`) |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | `modelId=deploymentName,...` comma map |

## 2. Managed-identity extension (piclaw, experimental)

`runtime/extensions/integrations/azure-openai.ts` (documented in
`docs/azure/azure-openai-extension.md`) registers two custom providers:

- `azure-openai` — text via the Responses API with **managed-identity auth via
  Azure IMDS** (no keys at all when running on an Azure VM), or a static key;
  GPT-5 reasoning, streaming, tool calling, model-specific request shaping.
- `azure-foundry` — Azure AI Foundry: text via completions, **image generation**
  (`/image`, `/flux` workspace commands, transparent PNG support).

Design rule: it deliberately does **not** register as `openai-responses` /
`openai-completions` (avoids collisions with Copilot and other providers); it
uses API names like `azure-openai-responses-mi`.

Supporting runtime code: `azure-openai-proxy.ts`, `azure-tool-call-limit.ts`,
`azure-openai-harness-helpers.ts`; finops notes include DeepSeek hosted in
Azure (`docs/finops/2026-09-22/sources/azure-deepseek.md`).

## 3. Go parity (`rcarmo/go-ai`, used by `rcarmo/gi`)

`azure.go` + `azure_config.go` implement the same access from Go, with upstream
tests covering the Responses API on Azure (cache session, tool choice,
reasoning replay, base-url resolution). This is a working reference for
protocol-correct Azure calls without the TS SDK.

## 4. Hosting and ops (`rcarmo/piclaw/docs/azure/`)

- `README.md` — full VM deployment guide: Debian/Ubuntu VM, bun install,
  `/workspace`, global install via `bun pm pack`, systemd user service
  (`PICLAW_WORKSPACE`, `PICLAW_AGENT_TIMEOUT=1800000`, port 3000).
- `azurevm-ops.md` — ops notes: SSH dual-stack socket fix, service restarts.
- `app-insights-agent-*.md/.json` — App Insights observability: Kusto queries
  and a ready workbook template.
- `azure-functions-feasibility-study-2026-04-17.md` — serverless option study.

## What Azure does NOT offer

- No Anthropic Messages protocol endpoint (not Claude Code compatible);
  `/v1/messages` paths are not part of the Azure OpenAI surface.
- No anonymous access; every call is scoped to a resource + key/identity.

## ReActClaw integration plan (not yet implemented)

Azure is OpenAI-compatible HTTP, so `FreePoolRouter` can consume it as a BYOK
entry without protocol changes:

- Base URL: `https://{AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`
  (or explicit `AZURE_OPENAI_BASE_URL`), path `/chat/completions`.
- Key: `AZURE_OPENAI_API_KEY`; deployment name via `AGENT_AZURE_DEPLOYMENT_MAP`
  mirroring pi's `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` semantics.
- Probe (inventory script): `/models` may 404 on locked-down resources; the
  reliable live check is a minimal `/chat/completions` call.

Suggested follow-ups:

1. Add `azure` to `scripts/inventory-gateways.ts` (group `byok`, chat-only).
2. Optional pool entry activated when the two env vars are present.
