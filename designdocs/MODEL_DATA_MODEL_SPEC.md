# Model Management — Data-Model Spec

> **Audience.** A coding agent implementing or modifying
> `src/modelManagement/`, and reviewers vetting the data model.

---

## 1. Scope & non-goals

### In scope

- Chat-model data model: providers, configured models, per-backend
  enabled-model selection.
- Catalog wiring (`models.dev`) — strictly setup-time.
- Provider origin discrimination (BYOK / agent-owned / Copilot Plus).
- A uniform on-disk shape that the chat-model factory and every
  backend picker consume.

### Out of scope

- **Embeddings.** Embeddings follow the same shape (provider →
  configured model → consumer) but are not landed in this iteration.
  The legacy `activeEmbeddingModels` / `embeddingModelKey` shape
  continues to work in the interim.
- **Global chat knobs.** No `temperature` / `maxTokens` /
  `reasoningEffort` / `verbosity` / `topP` / `frequencyPenalty`
  settings live in this data model. Adapters use their SDK defaults.
  If user-tunable knobs are ever needed, they belong elsewhere
  (per-invocation, per-skill, per-command).
- **Capability-based picker filtering.** Pickers show whatever the
  backend has enabled. If a model is incompatible with the backend at
  runtime, the runtime error path surfaces that. Catalog capability
  metadata still exists for display badges; it doesn't silently hide
  models.
- **Catalog at runtime.** Once a model is configured, the catalog is
  no longer consulted. The plugin must work fully when `models.dev`
  is unreachable.
- **Migration mechanics.** Migration from the current on-disk shape
  to this design is a separate task.
- **`BackendInventory` and runtime ACP reconciliation.** A future
  picker-reconciliation PR introduces a runtime types file for
  greying out temporarily-unreachable models; until then the picker
  shows every enabled `ConfiguredModel` and unreachable ones surface
  at request time.

---

## 2. Behaviors the data model must support

1. **Provider configuration with multi-instance.** A user can have
   two Anthropic credential sets ("prod" and "staging"), two Ollama
   endpoints, etc. Each instance is independently configured.
2. **Catalog drives the setup UI only.** The "Add Provider" / "Add
   Model" UI iterates `models.dev` (plus a small built-in template
   list for self-hosted endpoints) to scaffold defaults.
3. **One persisted model entity regardless of provenance.** Whether
   a model was seeded from the catalog (BYOK), auto-added at agent
   setup (Claude Code → Anthropic, Codex → OpenAI, OpenCode → Zen),
   or auto-added at Plus sign-in, the persisted row has the same
   shape. Provenance lives on the parent `Provider.origin`.
4. **Per-backend curated model selection.** Each of the four
   backends (`chat`, `opencode`, `claude-code`, `codex`) maintains
   its own `BackendConfig` listing the configured-model UUIDs it
   exposes in its picker, plus an optional default.
5. **Custom models on custom providers.** For self-hosted endpoints
   (Ollama, LMStudio, custom proxies) the catalog has nothing — the
   user adds a provider via a built-in template and types in models
   by hand.
6. **BYOK settings tab visibility.** The BYOK settings UI lists
   `Provider`s where `origin.kind === "byok"` only. Agent-owned and
   Plus providers are managed by their respective setup flows.
7. **Backend-supplied models are uniform with BYOK.** OpenCode Zen,
   the Anthropic provider that backs Claude Code, the OpenAI provider
   that backs Codex, and Plus-hosted models all manifest as
   `ConfiguredModel` rows under appropriate `Provider` rows. Pickers
   treat them uniformly.

---

## 3. Entities

### 3.1 `ProviderType` (closed dispatch union)

The chat-model factory's dispatch key. Five values; closed.

```ts
type ProviderType = "anthropic" | "openai-compatible" | "google" | "azure" | "bedrock";
```

The user never types this. The BYOK setup wizard reads it from the
catalog (mapping `models.dev`'s `npm` field — see §4). Agent setup
flows hardcode the value matching the SDK each agent uses. Plus
sign-in does the same.

### 3.2 `ModelInfo` (shared model description)

One shape used both as the catalog's per-model record and embedded
into `ConfiguredModel`. Eliminates duplication between catalog and
persisted views.

```ts
interface ModelInfo {
  /** Wire-form id passed to the SDK ("claude-sonnet-4-5", "gpt-5", …). */
  id: string;
  displayName: string;
  modalities?: { input: string[]; output: string[] };
  limits?: { context: number; output: number; input?: number };
  reasoning?: boolean;
  toolCall?: boolean;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  releaseDate?: string;
}
```

Catalog fetcher populates whatever `models.dev` exposes. Self-hosted
custom models populate `id` + `displayName` only.

### 3.3 `CatalogProvider` (transient)

A provider as listed by the catalog. Lives in memory during a setup
wizard pass; never persisted.

```ts
interface CatalogProvider {
  id: string; // "anthropic", "openai", "opencode-zen", …
  displayName: string; // from models.dev `name`
  defaultBaseUrl: string; // from models.dev `api`
  providerType: ProviderType; // derived from models.dev `npm`
  models: Record<string, ModelInfo>; // keyed by ModelInfo.id
}
```

### 3.4 `ProviderOrigin`

```ts
type ProviderOrigin =
  | { kind: "byok"; catalogProviderId?: string }
  | { kind: "agent"; agentType: AgentType }
  | { kind: "copilot-plus" };
```

- `byok` — user added via the BYOK settings tab.
  - `catalogProviderId` — the `models.dev` catalog id this row was created
    from (e.g. `"anthropic"`, `"openai"`, `"amazon-bedrock"`). A stable
    back-reference to the catalog: unlike `displayName` (user-editable) or
    `providerType` (ambiguous — `openai`, Groq, OpenRouter all map to
    `openai-compatible`), it pins the exact catalog entry so the Configure
    dialog can re-surface the full model list when editing. Set by
    `ByokSetupApi.addCatalogProvider`. Absent for future custom-endpoint
    BYOK providers (no catalog) and for rows persisted before this field
    existed — consumers fall back to the embedded `ConfiguredModel.info`
    snapshots when it's missing.
- `agent` — auto-created when an agent was set up; the agent owns
  credentials and routing. Chat doesn't appear here because chat
  doesn't own `Provider`s.
- `copilot-plus` — auto-created when the user signed into Plus.

### 3.5 `Provider` (persisted)

A configured connection to a model provider.

```ts
interface Provider {
  providerId: string; // UUID, PK
  providerType: ProviderType; // dispatch
  displayName: string;
  baseUrl?: string; // overrides catalog default
  apiKeyKeychainId?: string | null; // Obsidian keychain id; null if no key
  extras?: Record<string, unknown>; // per-providerType payload
  origin: ProviderOrigin;
  addedAt: number;
}
```

Multi-instance is supported within `origin.kind === "byok"`: two BYOK
`Provider` rows can share the same `providerType` (e.g. two Anthropic
accounts), distinguished by `providerId` and `displayName`. Agent and
Plus origins typically have exactly one row each, but the data model
doesn't enforce singleton.

`extras` is opaque, validated by the adapter on instantiation:

| `providerType`                           | `extras` shape                                                |
| ---------------------------------------- | ------------------------------------------------------------- |
| `azure`                                  | `{ azureDeploymentName, azureApiVersion, azureInstanceName }` |
| `bedrock`                                | `{ bedrockRegion }`                                           |
| `openai-compatible` (when org is needed) | `{ openAIOrgId }`                                             |

### 3.6 `ConfiguredModel` (persisted)

A model the plugin knows about.

```ts
interface ConfiguredModel {
  configuredModelId: string; // UUID, PK
  providerId: string; // FK to Provider
  info: ModelInfo; // embedded snapshot; uniqueness: (providerId, info.id)
  configuredAt: number;
}
```

"Configured" means "set up in the plugin, ready to use." Applies to
BYOK (user-added), agent-owned (auto-added at agent setup), and Plus
(auto-added at Plus sign-in) models alike — the difference is which
`Provider` this row belongs to.

"Configured" is distinct from "enrolled": a `ConfiguredModel` row
asserts the model exists on a provider; a backend separately enrolls
some subset of configured models for its picker via
`BackendConfig.enabledModels`. Auto-enrollment is the default UX, but
the two layers stay separate in the data model so per-backend pruning
is expressible.

### 3.7 `AgentType` and `BackendType`

```ts
type AgentType = "opencode" | "claude-code" | "codex";

type BackendType = AgentType | "chat";
```

- `AgentType` — the three agent backends. Each can own `Provider`s.
- `BackendType` — `AgentType` plus `"chat"` (Simple Chat). The map
  key for `BackendConfig`. Chat is a model destination but doesn't
  own providers.

### 3.8 `BackendConfig` (persisted)

```ts
interface BackendConfig {
  enabledModels: string[]; // each entry is a configuredModelId
  defaultModel?: string | null;
}
```

Per-backend curated selection. Persisted as
`settings.backends: Record<BackendType, BackendConfig>` — backend
identity is the map key, not a field on the row.

---

## 4. `ProviderType` rationale

The catalog lists 30+ providers (Anthropic, OpenAI, Google, Mistral,
Groq, OpenRouter, Together, DeepSeek, …) but the plugin only wires
five SDK families. Most providers ride on `openai-compatible` with a
custom `baseUrl`. The five values:

| `ProviderType`      | LangChain path                         | OpenCode `provider.set type` |
| ------------------- | -------------------------------------- | ---------------------------- |
| `anthropic`         | `@langchain/anthropic`                 | `anthropic`                  |
| `openai-compatible` | `@langchain/openai` + custom `baseUrl` | `openai-compatible`          |
| `google`            | `@langchain/google-genai`              | `google`                     |
| `azure`             | `@langchain/openai` (Azure path)       | `azure`                      |
| `bedrock`           | `@langchain/aws`                       | `bedrock`                    |

**Mapping from catalog to `ProviderType`**: the catalog fetcher reads
`models.dev`'s `npm` field on each provider entry:

| `npm` value         | `ProviderType`      |
| ------------------- | ------------------- |
| `@ai-sdk/anthropic` | `anthropic`         |
| `@ai-sdk/google`    | `google`            |
| `@ai-sdk/azure`     | `azure`             |
| `@ai-sdk/bedrock`   | `bedrock`           |
| (anything else)     | `openai-compatible` |

**Self-hosted providers** (Ollama, LMStudio, custom proxies) are not
listed by `models.dev`. The setup UI exposes them as built-in
templates and hardcodes `providerType: "openai-compatible"`.

Adding a sixth `ProviderType` value is a significant lift: it
requires LangChain code, agent-backend integration, and catalog
mapping. Most new providers should fit `openai-compatible`.

---

## 5. `Provider.origin` discrimination

`origin` is the only field that varies by provenance. Downstream
consumption (chat-model factory dispatch, picker enumeration,
backend bridging) is uniform.

| Origin         | Created by                                                                                                 | Visible in BYOK tab? |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- |
| `byok`         | User via BYOK "Add Provider" UI                                                                            | Yes                  |
| `agent`        | Agent setup flow (Claude Code → Anthropic; Codex → OpenAI; OpenCode → its full provider set including Zen) | No                   |
| `copilot-plus` | Plus sign-in flow                                                                                          | No                   |

The BYOK settings UI filters `providers` by
`origin.kind === "byok"`. Other surfaces (agent setup screens, Plus
account screen) manage their respective origins.

---

## 6. Top-level settings shape

```ts
interface CopilotSettings {
  // … existing non-model fields …

  providers: Record<string /* providerId */, Provider>;
  configuredModels: ConfiguredModel[]; // keyed by configuredModelId
  backends: Record<BackendType, BackendConfig>;

  // Reserved for embeddings parity (deferred). The legacy
  // activeEmbeddingModels + embeddingModelKey fields continue to work
  // until embeddings are folded in.
}
```

`ProviderType` / `ModelInfo` / `CatalogProvider` are not persisted —
catalog data is consumed in memory.

---

## 7. Invariants

| #   | Invariant                                                                                                                                                                     | Enforced by               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | `configuredModel.providerId ∈ keys(providers)`                                                                                                                                | Write path                |
| 2   | `(providerId, info.id)` is unique across `configuredModels`                                                                                                                   | Write path                |
| 3   | Every `BackendConfig.enabledModels[i]` is a valid `configuredModelId`; broken refs surface in the UI, never silently pruned                                                   | Runtime                   |
| 4   | `BackendConfig.defaultModel`, if non-null, is in `enabledModels`                                                                                                              | Write path                |
| 5   | Deleting a `Provider` cascades to its `ConfiguredModel`s. `BackendConfig.enabledModels` entries pointing at deleted models become broken refs (surfaced; not silently pruned) | Write path                |
| 6   | `apiKeyKeychainId` is non-null when the provider needs an API key; `null` for Ollama, LMStudio, and agent-owned providers that route through other credentials                | Runtime                   |
| 7   | BYOK settings UI shows only `providers` with `origin.kind === "byok"`                                                                                                         | UI                        |
| 8   | No uniqueness constraint on `providerType` across `providers` — multi-instance is supported                                                                                   | (explicit non-constraint) |

---

## 8. Resolution traces

### Trace A — BYOK Simple Chat, single Anthropic

1. User opens BYOK settings → "Add Provider" → picks "Anthropic" from
   the catalog list. Wizard creates
   `Provider{ providerId: "p1", providerType: "anthropic", origin: { kind: "byok" }, … }`.
2. User picks "Claude Sonnet 4.5" from the catalog's model list under
   Anthropic. Wizard creates
   `ConfiguredModel{ configuredModelId: "m1", providerId: "p1", info: ModelInfo{ id: "claude-sonnet-4-5", … } }`.
3. Auto-enrollment adds `"m1"` to `backends["chat"].enabledModels`.
4. User opens the Simple Chat picker → it reads
   `backends["chat"].enabledModels`, resolves each id to a
   `ConfiguredModel`, renders the list. User selects "Claude Sonnet
   4.5"; chat-model factory dispatches by
   `providers["p1"].providerType === "anthropic"` to the Anthropic
   LangChain adapter.

### Trace B — Agent-owned model (Claude Code → Anthropic)

1. User installs and configures the Claude Code agent. The agent
   setup flow creates
   `Provider{ providerId: "p2", providerType: "anthropic", origin: { kind: "agent", agentType: "claude-code" }, displayName: "Anthropic (Claude Code)" }`
   and uses Claude Code's CLI-managed credentials.
2. Setup fetches `models.dev` for the catalog's Anthropic models and
   creates `ConfiguredModel` rows for each one the agent supports,
   under `providerId: "p2"`, with full `info` snapshots.
3. Auto-enrollment populates `backends["claude-code"].enabledModels`
   with the new model ids.
4. BYOK settings UI doesn't show provider `"p2"` (filtered by
   `origin.kind === "byok"`).
5. Claude Code's picker reads `backends["claude-code"].enabledModels`
   and renders.

### Trace C — Multi-instance BYOK (two Anthropic keys)

1. User adds an "Anthropic" provider in BYOK →
   `Provider{ providerId: "p3", providerType: "anthropic", origin: { kind: "byok" }, displayName: "Anthropic (prod)" }`
   with prod key.
2. User clicks "Add Provider → Anthropic" again. BYOK UI does **not**
   filter Anthropic out (multi-instance allowed). A second provider:
   `Provider{ providerId: "p4", providerType: "anthropic", origin: { kind: "byok" }, displayName: "Anthropic (staging)" }`
   with staging key.
3. User configures Claude Sonnet 4.5 on both → two `ConfiguredModel`
   rows with different `configuredModelId`s, both pointing at the
   same wire-form `info.id: "claude-sonnet-4-5"`.
4. Simple Chat picker lists both; user disambiguates by parent
   provider's `displayName`.
5. Deleting `"p4"` cascades: its `ConfiguredModel` is removed; any
   `BackendConfig.enabledModels` ref to it becomes a broken ref
   (surfaced in UI). `"p3"`'s configured model is untouched.

### Trace D — Self-hosted (Ollama with hand-typed models)

1. User picks "Ollama" from the BYOK setup UI's built-in template
   list. Wizard creates
   `Provider{ providerId: "p5", providerType: "openai-compatible", origin: { kind: "byok" }, displayName: "Ollama (laptop)", baseUrl: "http://localhost:11434", apiKeyKeychainId: null }`.
2. User types "llama3.3:70b" as a model name. Wizard creates
   `ConfiguredModel{ providerId: "p5", info: ModelInfo{ id: "llama3.3:70b", displayName: "Llama 3.3 70B" } }` —
   `info` has only `id` + `displayName`; metadata fields stay empty.
3. From here, same flow as Trace A: enrollment, picker render,
   dispatch via `providerType: "openai-compatible"`.

---

## 9. Open questions

1. **Embeddings parity timing.** When does the embedding side adopt
   the same provider / configured-model / backend shape?
2. **Project-level model defaults.** Currently a project may pin a
   model. Does this become a project-scoped override of
   `backends["chat"].defaultModel`, or its own override mechanism?
3. **Per-invocation knobs.** If a user-facing temperature slider ever
   ships, where does it live? Spec says "not in the data model" —
   confirm.
4. **Migration mechanics.** A separate plan covers the migration
   from the current v0/v2 on-disk shape to the entities above.
5. **`BackendInventory`.** A future picker-reconciliation feature
   may need a runtime types file declaring ACP-reported model
   inventories so unreachable models can be greyed out. Out of scope
   here.
6. **Plus model registry shape.** Plus model metadata lives outside
   this module (in a Plus-specific registry). What's the contract
   between the Plus module and `ConfiguredModel` creation? Probably
   "Plus calls the same setup-flow helper" but worth nailing down.

---

## 10. Deferred fields

Fields considered and deferred from this iteration. Each carries a
re-add trigger.

### `CatalogProvider`

| Field           | Re-add trigger                                       |
| --------------- | ---------------------------------------------------- |
| `env: string[]` | "API key already in env?" detection feature          |
| `doc: string`   | Setup UI that shows provider doc links               |
| `npm` (raw)     | Never persisted; used only to compute `providerType` |

### `ModelInfo`

| Field                                            | Re-add trigger                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `family`                                         | Picker UI that groups models by family ("show latest in each family") |
| `temperature: boolean`                           | Setup UI that surfaces "temperature unsupported"                      |
| `attachment: boolean`                            | Picker badge for attachment-capable models                            |
| `knowledge: string`                              | Setup UI showing training cutoff                                      |
| `lastUpdated`, `openWeights`, `structuredOutput` | Speculative; add when a UI consumes them                              |

### `Provider`

| Field                                     | Re-add trigger         |
| ----------------------------------------- | ---------------------- |
| `lastVerifiedAt`, `lastVerificationError` | "Verify connection" UI |

### `ConfiguredModel`

| Field                                                                            | Re-add trigger                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `extras` (Ollama `numCtx`, OpenRouter prompt caching, OpenAI-compatible CORS, …) | An adapter that consumes a specific per-model knob |
| `lastVerifiedAt`, `lastVerificationError`                                        | Same as `Provider`                                 |
