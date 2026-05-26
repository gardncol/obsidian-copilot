# Model Management Redesign — Technical Design & Implementation Plan

> **Companion to:** `designdocs/MODEL_MANAGEMENT_REDESIGN.md` (product / UX spec) and `designdocs/MODEL_DATA_MODEL_SPEC.md` (the canonical data model — entity shapes, settings layout, invariants).
> **This doc owns:** library choice, migration strategy, code-architecture changes, UX flows, dialog wireframes, milestone breakdown with verification checklists.
> **Audience:** A background implementation agent. Each milestone is self-contained and verifiable without human approval.
>
> **Scope decisions reflected here:**
>
> - BYOK is the central registry for _user-brought_ keys only (no built-in models, no OpenCode/Plus models).
> - No per-model or per-provider "Availability" / "Capability" toggles; model rows are display-only inside one global table.
> - No global chat knobs (`temperature` / `maxTokens` / `reasoningEffort` / `verbosity`); adapters use SDK defaults.
> - Quick Chat as a fourth agent sub-tab (skeleton only; runtime routing in the follow-up doc).
> - Lazy `models.dev` fetching (BYOK-tab-triggered, not on plugin boot).
> - `src/modelManagement/` module with enforced import boundary.
> - Embedding models live in the "Embedding" tab (other Embedding settings stay where they are, embedding section sits at the bottom).
> - Welcome modal is out of scope.

---

## 0. Context

The current model management implementation has three duplicated UI surfaces (Basic Settings provider keys, Models Settings table, Agent Mode model curation), with provider API keys scattered as ~25 top-level fields on `CopilotSettings`, and `activeModels` doubling as both "enabled chat models" and "API credential carrier". The redesign (`MODEL_MANAGEMENT_REDESIGN.md`) consolidates this into a single **BYOK** tab + dedicated **Agent** tab, backed by a unified provider registry and a live `models.dev` catalog.

**BYOK is the central place to configure the _new_ keys and models a user brings to Copilot** (Anthropic / OpenAI / Google / Ollama / custom endpoints / etc). It is **not** a master list of every model the plugin can reach: OpenCode-bundled models (Big Pickle, …) and Copilot-Plus hosted models (Plus Flash, …) **never appear in BYOK**. Those live exclusively in the OpenCode sub-tab of the Agent panel. The BYOK description copy makes this explicit: _"The central place to configure the providers and models you bring to Copilot. OpenCode-bundled and Copilot Plus models are configured in the Agent → OpenCode sub-tab."_

Curation of which models surface in a specific agent's in-session picker is a per-agent concern that lives in the Agent tab.

This implementation plan also takes the opportunity to **separate concerns** that are currently tangled:

| Concern                                                 | Today                                                                                                               | After redesign                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credentials                                    | ~25 ad-hoc fields on `CopilotSettings` (`openAIApiKey`, `anthropicApiKey`, `amazonBedrockRegion`, …)                | One typed `providers: Record<InstanceId, ProviderInstance>` map. Multi-instance: same provider type can appear multiple times.                                                                       |
| Enabled models                                          | `activeModels: CustomModel[]` (also carries API keys, base URLs, per-model overrides)                               | One `enrollments: ByokEnrollment[]` keyed by `(instanceId, modelId)`. Catalog-backed and user-declared models share the same shape; catalog membership decides which.                                |
| Built-in catalog of pre-listed models                   | Hard-coded in `src/constants.ts` (`BUILTIN_CHAT_MODELS`) — pre-populated regardless of whether the user has the key | **Eliminated.** `enrollments` contains _only_ models the user explicitly enrolled. Migration drops any pre-listed entry whose provider has no configured key (the user was never actually using it). |
| Available models per provider (for the picker)          | Hard-coded built-in list                                                                                            | Lazy `models.dev/api.json` with disk cache                                                                                                                                                           |
| Default chat model                                      | `defaultModelKey` field                                                                                             | **Per-consumer** `defaultModel: ConsumerModelRef \| null` on each `ConsumerConfig`. No single global default.                                                                                        |
| Per-model overrides (temp, max_tokens, capabilities, …) | Per-`CustomModel` fields                                                                                            | **Removed.** No `temperature` / `maxTokens` / `reasoningEffort` / `verbosity` / `topP` / `frequencyPenalty` in the data model at all; adapters use SDK defaults. Capabilities come from the catalog. |
| Per-provider "Availability" toggles (chat/agent/mobile) | Implicit in code                                                                                                    | **Removed** — pipeline reachability (`ProviderType.pipelines = {langchain, opencode}`) declares which consumers can use a provider; per-consumer `enabledModels` curates further.                    |
| Per-model "Hide from picker" checkbox in BYOK table     | `enabled: false` on `CustomModel`                                                                                   | **Removed** — to hide a model, uncheck it inside Configure Provider (this removes it from `enrollments`; per-consumer curation lives in `consumers[<id>].enabledModels`)                             |
| Settings versioning                                     | Heuristic (presence/type checks)                                                                                    | Explicit `settingsVersion: number` with a registered migration chain                                                                                                                                 |
| Embedding model management                              | Inside "Models" tab alongside chat models                                                                           | Bottom section of the **renamed "Embedding" tab** (was "QA"); other QA settings stay in place.                                                                                                       |
| LangChain chat                                          | Implicit "chain mode" coupled to chat input                                                                         | **Becomes the "Quick Chat" agent backend** — see `designdocs/QUICK_CHAT_AGENT_INTEGRATION.md` (follow-up doc; out of scope for this plan)                                                            |

---

## 1. Library / Data Source Choice

### 1.1 Model catalog: lazy `models.dev` + disk cache

**Decision:** Fetch [`https://models.dev/api.json`](https://models.dev) **lazily** — only when the user actually needs catalog data (visits the BYOK tab, opens Configure Provider, opens Add Provider, or clicks `[Refresh catalog]`). **No fetch on plugin boot**, no fetch during chat sessions, no fetch during agent sessions. Persist successful fetches to a local disk cache. Before the first successful fetch in this vault, the catalog is empty.

**Two-tier read priority** (top wins):

1. **Memory cache** — populated on first `ensureLoaded()` call (lazy). Refreshed by a successful live fetch.
2. **Disk cache** — `{vault}/.obsidian/plugins/copilot/.modelsCatalogCache.json`. Written on every successful live fetch; read lazily on first `ensureLoaded()`. When absent, memory starts empty until the first `refresh()` lands.

**Fetch triggers** (the only ones):

- User opens the BYOK tab (`ensureLoaded()` + auto-refresh if last successful fetch >24h old, or if no disk cache exists).
- User opens **Configure Provider** or **Add Provider** dialog (`ensureLoaded()`; no auto-refresh — the BYOK tab open already covered freshness).
- User clicks the **`[Refresh catalog]`** ghost button in the BYOK header.

**Not triggered:**

- ❌ Plugin `onload` — catalog service stays uninitialized until a BYOK-side caller asks.
- ❌ Chat session start — chat reads `ProviderRegistry` + `EnrollmentRegistry` (which don't need the catalog at all; catalog only powers the BYOK _picker_).
- ❌ Agent session start — same reason.

**Fetch behavior:**

- 5s timeout. On timeout or non-200, log a `logWarn` and keep serving the existing memory/disk source.
- The catalog service emits change events so the BYOK tab + Configure Provider dialog re-render when fresh data arrives.

**Why lazy:**

- Most plugin sessions never touch the BYOK tab (users configure once, then chat); fetching on boot wastes a network round-trip every launch.
- The catalog is metadata for the _picker_ — enrolled models live in `settings.enrollments` and are usable without ever calling `ModelCatalogService`. The runtime chat/agent paths don't need it.

**Why two tiers:**

- Live fetching keeps the catalog fresh as `models.dev` adds new models — no waiting for plugin updates to see GPT-5.6 etc.
- Disk cache keeps offline use seamless across sessions once we've fetched at least once.

**Why no bundled snapshot:** Earlier drafts shipped a tree-shaken `modelsCatalog.fallback.json` for the fresh-install + offline case. That introduced two ongoing costs (a maintainer ritual to refresh it; a synchronous JSON import in the migration) for a narrow benefit. Fresh-install offline now shows an empty picker with a `[Refresh catalog]` retry CTA — acceptable since BYOK fundamentally needs internet to validate keys anyway.

**Why not live-only on every read:** Catalog data is too large to fetch on every render; disk cache amortizes across sessions.

### 1.2 Provider allowlist (only providers with first-class LangChain adapters)

**Scoped to providers this plugin can actually instantiate via its existing LangChain adapters** (the `ChatModelProviders` enum in `chatModelManager.ts`). Showing catalog entries for providers we can't actually call is a UX trap.

```
anthropic, openai, google, groq, mistral, xai, deepseek,
openrouter, cohere, azure, amazon-bedrock, github-copilot,
ollama, lmstudio, siliconflow, openai-compatible
```

**Not supported:** `togetherai`, `fireworks-ai`, `perplexity` — no first-class LangChain adapter in this plugin. Users who want them can still add them as a custom provider using the `openai-compatible` path.

(Note on ids: `xai` not `x-ai`; `amazon-bedrock` not `aws-bedrock`. Verified against live `api.json`.)

The live fetch + disk cache hold the filtered set (filtered client-side after fetch since `models.dev` doesn't accept server-side filters).

> **Single source of truth for the allowlist:** Export a `SUPPORTED_PROVIDER_IDS` constant from `src/modelManagement/providers/supportedProviders.ts`. The catalog filter, the Add Provider dialog's list, the migration step, and the `eslint`-enforced provider adapter registry all reference the same constant. Adding a new provider = (1) add adapter class, (2) add id to `SUPPORTED_PROVIDER_IDS`. Nothing else.

### 1.3 Catalog shape (hand-rolled TypeScript types)

Place in `src/data/modelsCatalog.types.ts`:

```typescript
export interface CatalogProvider {
  id: string; // "anthropic"
  name: string; // "Anthropic"
  env: string[]; // ["ANTHROPIC_API_KEY"]
  npm?: string;
  api?: string; // default base URL
  models: Record<string, CatalogModel>;
}

export interface CatalogModel {
  id: string; // "claude-sonnet-4-5-20250929"
  name: string; // "Claude Sonnet 4.5"
  family?: string;
  attachment?: boolean; // accepts attachments
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  knowledge?: string; // training cutoff
  release_date?: string; // surfaced as "Sep 2025" column in Configure Provider
  last_updated?: string;
  open_weights?: boolean;
  modalities: { input: string[]; output: string[] }; // input includes "image" → Vision (used for routing only, not UI)
  limit: { context: number; output: number };
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
}

export type ModelsCatalog = Record<string, CatalogProvider>;
```

> **Capability fields belong on the catalog, not on enrollments.** `CatalogModel.reasoning` / `tool_call` / `modalities.input` is consulted at the point of use. Enrollments carry `declaredCapabilities` only for user-declared models (no catalog match) — see `MODEL_DATA_MODEL_SPEC.md` §3.4.

### 1.4 Catalog service

Create `src/modelManagement/catalog/ModelCatalogService.ts` — a thin lazy read-only facade with the two-tier read path:

```typescript
class ModelCatalogService {
  // Idempotent. First call triggers disk read; subsequent calls are no-ops.
  // Returns immediately after memory cache is populated (empty if no disk cache yet).
  ensureLoaded(): Promise<void>;

  // All reads are synchronous after ensureLoaded() resolves.
  getProvider(id: ProviderTypeId): CatalogProvider | undefined;
  getModel(providerTypeId: ProviderTypeId, modelId: string): CatalogModel | undefined;
  getAllProviders(): CatalogProvider[]; // sorted: recommended first (Anthropic / OpenAI / Google)
  searchModels(
    providerTypeId: ProviderTypeId,
    query: string,
    filters: CatalogFilters
  ): CatalogModel[];

  // Live data integration
  refresh(): Promise<RefreshResult>; // user-triggered or auto-triggered (BYOK tab open + 24h stale)
  getMeta(): { fetchedAt: number | null; source: "live" | "disk" | null };
  onChange(listener: () => void): () => void; // emits when memory cache updates
}

interface CatalogFilters {
  contextAtLeast?: number; // ≥ 200k ctx chip
  maxCostPerMillion?: number; // ≤ $1/M chip
  releasedWithinMonths?: number; // Released ≤ 6mo chip
}
```

**No `capability` filter in `searchModels`.** Capability filters (Vision / Reasoning / Tool use) don't exist in the UI. Catalog code can still inspect `tool_call` / `reasoning` / `modalities.input` for internal routing decisions (the Quick Chat agent will need to know whether a model supports tool calls, for example).

**`ModelCatalogService` is for the BYOK picker only.** BYOK never shows OpenCode-bundled or Copilot-Plus models. The OpenCode sub-tab in the Agent panel queries OpenCode directly for its bundled list and Copilot-Plus for its hosted list; those are merged with BYOK agent-capable enrollments to populate the OpenCode picker at render time. See §5.4.1 and M8.

---

## 2. Data model

The canonical data model — entities (`ProviderType`, `ProviderInstance`, `ByokEnrollment`, `ConsumerConfig`, `ConsumerModelRef`, `BackendInventory`, `CatalogModel`), settings shape, invariants, and resolution traces — lives in `designdocs/MODEL_DATA_MODEL_SPEC.md`. Read that doc before touching any of the schemas, migrations, or registries described here.

For orientation, the persisted slice of `CopilotSettings` that this redesign owns:

```ts
interface CopilotSettings {
  // … existing non-model fields …

  settingsVersion: number;                                   // = 2 after migration

  // Multi-instance providers, keyed by instanceId (UUID). Same provider type
  // may appear multiple times (two Anthropic keys, two Ollama endpoints, …).
  providers: Record<string /* instanceId */, ProviderInstance>;

  // BYOK enrollments. FK by instanceId. Catalog-backed and user-declared
  // (non-catalog) models share the same shape; catalog membership decides which.
  enrollments: ByokEnrollment[];

  // Per-consumer model curation (LangChain consumers + agent backends, uniform shape).
  consumers: Record<ConsumerId, ConsumerConfig>;

  // Legacy embeddings fields stay until embedding-side rollout:
  activeEmbeddingModels: ...;
  embeddingModelKey: string | null;
}
```

### 2.1 API key storage

The existing `KeychainService` (`src/services/keychainService.ts`) supports per-field keychain storage with a vault-scoped ID scheme. Extend it with a new namespace:

```
copilot-v{8hex-vault-id}-provider-{instanceId}-apiKey
copilot-v{8hex-vault-id}-provider-{instanceId}-extra-{name}
```

`ProviderInstance.apiKey` is `{ kind: "keychain"; id: string }` or `{ kind: "inline"; value: string }` depending on whether keychain is available (the `_keychainOnly` setting governs this).

### 2.2 Settings version field

`settingsVersion: number` on `CopilotSettings`. `0` = original schema, `2` = post-redesign.

Migration runner (`src/modelManagement/migrations/runMigrations.ts`):

```ts
type Migration = (raw: any) => any;
const MIGRATIONS: Record<number, Migration> = { 2: migrateV0toV2 };
function runMigrations(raw: any): { settings: any; migrationsApplied: number[] };
```

Called once inside `sanitizeSettings` before any other normalization, on every settings load. Idempotent (no-op when `settingsVersion === current`).

A sticky breadcrumb `settings._migrationBreadcrumbs: Array<{ from: number; to: number; appliedAt: number; droppedFields?: string[] }>` records what ran, for forensics and to power the one-time toast in §4.4.

---

## 3. Code architecture — separation of concerns

### 3.0 One module, one boundary: `src/modelManagement/`

All provider, model, catalog, and BYOK-UI code lives in a single top-level module under `src/modelManagement/`. The module has **one public entry point** — `src/modelManagement/index.ts` — and an **eslint-enforced import boundary** prevents the rest of the codebase from reaching past it into internals.

**Public API surface** (everything else is private to the module):

```typescript
// src/modelManagement/index.ts — the ONLY file outside callers may import from
export { ProviderRegistry } from "./providers/ProviderRegistry";
export { EnrollmentRegistry } from "./registry/EnrollmentRegistry";
export { ConsumerRegistry } from "./consumers/ConsumerRegistry";
export { ModelCatalogService } from "./catalog/ModelCatalogService";
export { ChatModelManager } from "./chatModel/ChatModelManager";
export type {
  InstanceId,
  ProviderTypeId,
  ProviderInstance,
  ByokEnrollment,
  ConsumerId,
  ConsumerConfig,
  ConsumerModelRef,
  KeychainRef,
  VerificationResult,
} from "./types";
export { ByokPanel } from "./ui/tabs/ByokPanel";
export { runModelManagementMigrations } from "./migrations/runMigrations";
export { SUPPORTED_PROVIDER_TYPE_IDS } from "./providers/supportedProviders";
```

**Enforcement:** `eslint-plugin-import`'s `no-restricted-paths` rule:

```js
// .eslintrc.js (or eslint.config.js)
"import/no-restricted-paths": ["error", {
  zones: [{
    target: "./src/!(modelManagement)/**",
    from: "./src/modelManagement/!(index.ts)",
    message:
      "Import model management code via @/modelManagement (the module's public API), " +
      "not from internal files. See designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.0.",
  }],
}]
```

The module owns providers + enrollments + consumers + catalog + the BYOK UI. Consumers (agent backends, chat input, embeddings) talk to it through this surface and never reach inside.

**What stays outside the module:**

- Agent backend internals (`src/agentMode/backends/*`) — they consume `EnrollmentRegistry` + `ProviderRegistry` + `ConsumerRegistry` via the public API.
- Chat view + chat input — same.
- Embeddings management — keeps its own surface in `src/embedding/` (separate workstream).
- Settings shell / non-model tabs (`Chat`, `Commands`, etc.) — they just register `ByokPanel` as a tab component.

### 3.1 `src/modelManagement/providers/ProviderRegistry.ts`

Source of truth for `ProviderInstance` rows. Wraps `settings.providers` + keychain.

```typescript
class ProviderRegistry {
  list(): ProviderInstance[];
  get(id: InstanceId): ProviderInstance | undefined;
  listByTypeId(typeId: ProviderTypeId): ProviderInstance[]; // multi-instance lookup
  add(config: Omit<ProviderInstance, "instanceId" | "addedAt">): Promise<InstanceId>;
  update(id: InstanceId, patch: Partial<ProviderInstance>): Promise<void>;
  remove(id: InstanceId): Promise<void>; // cascades to enrollments + consumer refs
  getApiKey(id: InstanceId): Promise<string | null>;
  verify(id: InstanceId): Promise<VerificationResult>;
}
```

### 3.2 `src/modelManagement/registry/EnrollmentRegistry.ts`

Source of truth for `ByokEnrollment` rows. Wraps `settings.enrollments`.

```typescript
class EnrollmentRegistry {
  list(filter?: { instanceId?: InstanceId }): ByokEnrollment[];
  get(instanceId: InstanceId, modelId: string): ByokEnrollment | undefined;
  add(entry: Omit<ByokEnrollment, "enrolledAt">): Promise<void>;
  remove(instanceId: InstanceId, modelId: string): Promise<void>;
  bulkSet(instanceId: InstanceId, entries: ByokEnrollment[]): Promise<void>; // Configure Provider save
  isCustomModel(e: ByokEnrollment): boolean; // catalog membership check
}
```

### 3.3 `src/modelManagement/consumers/ConsumerRegistry.ts`

Source of truth for `ConsumerConfig` rows. Wraps `settings.consumers`.

```typescript
class ConsumerRegistry {
  get(id: ConsumerId): ConsumerConfig;
  setEnabledModels(id: ConsumerId, refs: ConsumerModelRef[]): Promise<void>;
  setDefaultModel(id: ConsumerId, ref: ConsumerModelRef | null): Promise<void>;
  // Resolves enabledModels against current providers/enrollments + runtime BackendInventory.
  // Returns the entries the picker should render for this consumer.
  visibleEntries(id: ConsumerId): VisibleEntry[];
}
```

### 3.4 `src/modelManagement/catalog/ModelCatalogService.ts`

Covered in §1.4. Lazy, read-only facade with two-tier fallback.

### 3.5 `ChatModelManager` refactor

Builds a LangChain client by reading `ProviderRegistry.get(instanceId)` + `EnrollmentRegistry.get(instanceId, modelId)`. No `ChatDefaults`, no per-invocation `temperature` / `maxTokens` / `reasoningEffort` / `verbosity`. Adapter knobs (OpenRouter prompt caching, OpenAI-compatible CORS, Ollama `numCtx`, …) flow from `ByokEnrollment.overrides`.

A pure helper `buildLangChainConfig(provider: ProviderInstance, enrollment: ByokEnrollment): ChatModelConfig` lives in its own file (no LangChain imports — unit-testable per `AGENTS.md` testing guidance).

**Out of scope here:** Quick Chat integration (chat input → Quick Chat → LangChain wiring) — see `designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`.

### 3.6 Folder layout (everything model-related lives here)

```
src/
├─ modelManagement/                              ← THE MODULE (one boundary)
│  ├─ index.ts                                   ← public API surface (§3.0)
│  ├─ types.ts                                   ← ProviderInstance, ByokEnrollment, ConsumerConfig, …
│  ├─ catalog/
│  │  ├─ ModelCatalogService.ts                  ← lazy + 2-tier read
│  │  └─ modelsCatalog.types.ts
│  ├─ providers/
│  │  ├─ ProviderRegistry.ts
│  │  ├─ supportedProviders.ts                   ← SUPPORTED_PROVIDER_TYPE_IDS (single source)
│  │  └─ adapters/
│  │     ├─ AnthropicAdapter.ts                  (each adapter exports langchain factory
│  │     ├─ OpenAIAdapter.ts                      + extraSchema: z.ZodSchema)
│  │     ├─ GoogleAdapter.ts
│  │     ├─ AzureAdapter.ts                      ← uses extraSchema for instance/deployment/version
│  │     ├─ BedrockAdapter.ts                    ← uses extraSchema for region
│  │     ├─ ...
│  │     └─ index.ts                             ← adapter registry keyed by AdapterKind
│  ├─ registry/
│  │  └─ EnrollmentRegistry.ts
│  ├─ consumers/
│  │  └─ ConsumerRegistry.ts
│  ├─ chatModel/
│  │  ├─ ChatModelManager.ts                     ← reads ProviderRegistry + EnrollmentRegistry
│  │  └─ buildLangChainConfig.ts                 ← pure helper (no LangChain import)
│  ├─ migrations/
│  │  ├─ runMigrations.ts
│  │  ├─ v0-to-v2.ts
│  │  └─ __tests__/                              ← fixture-based migration tests
│  └─ ui/
│     ├─ tabs/
│     │  └─ ByokPanel.tsx
│     ├─ dialogs/
│     │  ├─ AddProviderDialog.tsx
│     │  ├─ ConfigureProviderDialog.tsx
│     │  └─ AddCustomModelDialog.tsx
│     └─ components/
│        ├─ ByokGlobalTable.tsx                  ← one global table w/ provider section rows
│        └─ ProviderCatalogList.tsx
│
├─ settings/
│  ├─ model.ts                                   ← schema only; thin (uses modelManagement types)
│  ├─ v2/                                        ← Chat / Commands / Embedding tabs
│  │  └─ components/
│  │     ├─ QASettings.tsx                       ← renamed "Embedding" tab
│  │     └─ EmbeddingModelsSection.tsx
│  └─ v3/                                        ← only the NON-model tabs (Agent, …)
│     ├─ tabs/
│     │  └─ AgentPanel.tsx                       (consumes @/modelManagement)
│     └─ components/
│        ├─ BackendSubtabs.tsx
│        ├─ BackendStatusCard.tsx
│        └─ BackendModelPicker.tsx               ← shared "Models in this backend's picker"
│
```

No build-time snapshot. The catalog is purely a runtime concern — live fetch + disk cache, no bundled JSON.

### 3.7 Provider adapters own their `extra` shape

Each adapter under `src/modelManagement/providers/adapters/` exports two things:

```typescript
// Example: AzureAdapter.ts
import { z } from "zod";

export const extraSchema = z.object({
  azureInstanceName: z.string().min(1),
  azureDeploymentName: z.string().min(1),
  azureApiVersion: z.string().min(1),
}).strict();

export function buildLangChainClient(
  provider: ProviderInstance,
  enrollment: ByokEnrollment,
): BaseChatModel {
  const extra = extraSchema.parse(provider.extras);   // throws → caught + surfaced as verification error
  return new AzureChatOpenAI({ ... extra ... });
}
```

`extraSchema` defaults to `z.object({}).strict()` for adapters with no extras. The Configure Provider dialog uses the schema (via a `getExtraFormFields(adapter)` helper) to render the right inputs in the "advanced" section — adding a new provider's extra field is a one-line schema change, no UI rewrite required.

This keeps `ProviderInstance.extras: Record<string, unknown>` opaque at the core-type level while letting each provider declare exactly what it needs.

---

## 4. Migration strategy (v0 → v2)

### 4.1 Where it runs

Inside `sanitizeSettings(raw)` in `src/settings/model.ts`, immediately after parsing data.json and **before** field normalization. Single entry point; runs on every load; idempotent when `settingsVersion >= 2`.

### 4.2 Migration steps (v0 → v2)

Implemented in `src/modelManagement/migrations/v0-to-v2.ts`. Order matters:

1. **Initialize new shape** — `settings.providers = {}`, `settings.enrollments = []`, `settings.consumers = {}`, `settings._migrationBreadcrumbs = settings._migrationBreadcrumbs ?? []`.

2. **Built-in provider keys → `ProviderInstance` rows.** For each non-empty legacy provider field, synthesize one `ProviderInstance` with a fresh UUID `instanceId` and `providerTypeId` from this table:

   | Legacy field(s)                                        | Synthesized provider                                                                    |
   | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
   | `openAIApiKey` (+ `openAIOrgId`, `openAIProxyBaseUrl`) | `providerTypeId: "openai"` (extras: `openAIOrgId`, `baseUrl` if proxy set)              |
   | `anthropicApiKey`                                      | `providerTypeId: "anthropic"`                                                           |
   | `googleApiKey`                                         | `providerTypeId: "google"`                                                              |
   | `cohereApiKey`                                         | `providerTypeId: "cohere"`                                                              |
   | `mistralApiKey`                                        | `providerTypeId: "mistral"`                                                             |
   | `deepseekApiKey`                                       | `providerTypeId: "deepseek"`                                                            |
   | `groqApiKey`                                           | `providerTypeId: "groq"`                                                                |
   | `xaiApiKey`                                            | `providerTypeId: "xai"`                                                                 |
   | `openRouterAiApiKey`                                   | `providerTypeId: "openrouter"`                                                          |
   | `siliconflowApiKey`                                    | `providerTypeId: "siliconflow"`                                                         |
   | `amazonBedrockApiKey` (+ `amazonBedrockRegion`)        | `providerTypeId: "amazon-bedrock"` (extras: `bedrockRegion`)                            |
   | `azureOpenAIApiKey` (+ instance/deployment/version)    | `providerTypeId: "azure"` (extras: `azureInstanceName`, `azureDeploymentName`, version) |
   | `huggingfaceApiKey`                                    | **Dropped** (not in `SUPPORTED_PROVIDER_TYPE_IDS` — log to breadcrumbs)                 |

   Each synthesized `ProviderInstance` gets `displayName` defaulted from the `ProviderType.displayName`, `addedAt: Date.now()`.

3. **Custom-provider `CustomModel` entries → custom `ProviderInstance` rows.** Group legacy `activeModels` entries by unique `{baseUrl, apiKey}` tuple (when `provider` is `OPENAI_FORMAT`, `OLLAMA`, `LM_STUDIO`, or any `isBuiltIn: false` entry with a `baseUrl`). Each group becomes one `ProviderInstance`:

   ```
   instanceId:     <fresh UUID>
   providerTypeId: "openai-compatible" | "ollama" | "lmstudio" (inferred from `provider` field)
   displayName:    baseUrl-derived label, e.g. "Ollama (localhost:11434)"
   baseUrl:        <baseUrl>
   apiKey:         { kind: "keychain", id: "…" } or { kind: "inline", value: "…" }
   ```

4. **`activeModels` (chat half) → `enrollments`.** For each entry, drop-or-migrate:
   - **Drop** (no enrollment row; log to breadcrumbs) if **any** is true:
     - `entry.isEmbeddingModel === true` (handled by legacy `activeEmbeddingModels`).
     - `entry.enabled === false` (no per-enrollment visibility flag in the new shape).
     - `entry.isBuiltIn === true` **and** no `ProviderInstance` was synthesized for that provider type in step 2. The user never had a key — the entry was just legacy `BUILTIN_CHAT_MODELS` clutter.
     - `entry.provider` is OpenCode-bundled or Copilot Plus. Those go through `consumers["agent:opencode"].enabledModels` (see step 6) with `source: "backend-bundled"` or `source: "copilot-plus"`, never into `enrollments`.

   - Otherwise **migrate** to a `ByokEnrollment`:
     ```
     instanceId:            <instanceId of the ProviderInstance from step 2 or 3>
     modelId:               entry.name
     displayName:           entry.displayName ?? entry.name
     enrolledAt:            Date.now()
     declaredContextLimit:  entry.contextLength (only if custom — no catalog match)
     declaredCapabilities:  derived from entry.capabilities (only if custom)
     overrides:             { ollama numCtx / openrouter promptCaching / openai-compat CORS }
                            (only the adapter-knob fields; chat-tuning fields are dropped — see step 5)
     ```

   Migration does not read the catalog. For catalog-backed enrollments, `declared*` fields stay undefined and runtime readers fall back to `CatalogModel`. Net effect: a user with no legacy keys ends up with `providers = {}` and `enrollments = []`; a user with the OpenAI key only keeps OpenAI enrollments (Anthropic/Google built-ins drop).

5. **Per-`CustomModel` chat-tuning overrides → dropped, logged.** `temperature`, `maxTokens`, `topP`, `frequencyPenalty`, `reasoningEffort`, `verbosity`, `stream`, `streamUsage`, `useResponsesApi`, `capabilities` (user-set) get pushed to `_migrationBreadcrumbs[*].droppedFields`. The toast in §4.4 reads from this. (Adapter knobs like `numCtx`, `enablePromptCaching`, `enableCors` move to `ByokEnrollment.overrides` per step 4.)

6. **Build `settings.consumers` for ALL consumers.**
   - LangChain-side consumers (`chat`, `vault-qa`, `project`, `copilot-plus`, `quick-chat`): initialize as `{ enabledModels: [], defaultModel: <ref-from-defaultModelKey-or-null> }`. Empty `enabledModels` is the "everything enabled" heuristic, preserving current behavior. `defaultModel` is resolved by looking up legacy `defaultModelKey` (`<name>|<provider>` format) against the new `enrollments`; on a successful match, set `defaultModel: { source: "byok", enrollmentRef: "${instanceId}::${modelId}" }` for the `chat` consumer (other LangChain consumers get the same default for continuity).
   - Agent consumers (`agent:opencode`, `agent:claude-code`, `agent:codex`): translate legacy `agentMode.backends.<id>.modelEnabledOverrides` into `enabledModels: ConsumerModelRef[]`. Each entry becomes:
     - BYOK match (`<byokInstanceId>/<modelId>` or `<modelName>|<provider>` resolvable against `enrollments`): `{ source: "byok", enrollmentRef }`.
     - OpenCode bundled (`bigpickle/…` etc.): `{ source: "backend-bundled", backendId: "opencode", backendModelId }`.
     - Copilot Plus (`copilot-plus/…`): `{ source: "copilot-plus", modelId }`.
     - For Claude Code / Codex bare model ids: `{ source: "backend-bundled", backendId, backendModelId: modelId }`.
       Drop unresolved entries; log to breadcrumbs.
   - `command:<id>` consumers: not created upfront. The commands subsystem creates them lazily the first time a command pins a model.

7. **Drop fields not represented in the new data model.** `defaultModelKey`, `temperature`, `maxTokens`, `reasoningEffort`, `verbosity`, `topP`, `frequencyPenalty`, `agentMode.enabled`, `agentMode.backends.<id>.modelEnabledOverrides`. Log each dropped field-path to breadcrumbs.

8. **API keys → keychain.** If keychain is available (`_keychainOnly` is true), each migrated provider's `apiKey` is moved into the new `provider-<instanceId>-apiKey` keychain entry and the legacy entry (`<providerType>-api-key`) is deleted. If keychain unavailable, `apiKey = { kind: "inline", value: <key> }`.

9. **Delete legacy top-level fields** — remove all the legacy provider-key fields (§4.2 step 2 table) from the settings object so they're gone from `data.json` after first save.

10. **Stamp version** — `settings.settingsVersion = 2`; append breadcrumb `{ from: 0, to: 2, appliedAt: Date.now(), droppedFields: [...] }`.

### 4.3 Backwards-compatibility safety net

If migration **fails** mid-way (throws), we:

- catch the error in `runMigrations`,
- restore the pre-migration settings object,
- log to `console.error` via `logError`,
- show a one-time `Notice` toast: _"Couldn't upgrade your Copilot settings — please report this. The plugin will keep working with your existing settings for now."_,
- leave `settingsVersion` at the old value so we retry next launch.

Settings are never partially-mutated — the migration runs on a deep clone and only assigns back on success.

### 4.4 Migration notice (one-time toast)

After successful v0→v2 migration, on the next plugin tick, surface a dismissible `Notice` with:

```
Copilot settings upgraded.
• Per-model temperature / max-tokens / capability overrides removed.
• Provider keys moved to the BYOK tab.
• Default chat model is now per-consumer (Chat, Vault QA, Project, …).
• Pre-listed built-in models removed for providers you hadn't configured. (4 removed)
Open BYOK tab →   Dismiss
```

The exact line items are dynamically built from `_migrationBreadcrumbs[last].droppedFields`. The user can dismiss; we set `settings._migrationNoticeDismissed = true` so it never reappears. The toast is also a link to the new BYOK tab.

### 4.5 How an implementer or user can tell if migration ran

| Signal            | Where                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Primary indicator | `settings.settingsVersion >= 2`                                                                                     |
| Forensic detail   | `settings._migrationBreadcrumbs[*]` (preserved across loads)                                                        |
| User-facing       | One-time `Notice` (§4.4); also surfaces in **Settings → About** card: _"Settings schema v2 (migrated Mar 4, 2026)"_ |
| Programmatic      | `ProviderRegistry.list()` returns non-empty when keys existed pre-migration                                         |

A new dev command `Copilot: Show settings migration status` (registered in `main.ts`) opens a small modal that dumps the breadcrumbs — useful for support.

---

## 5. UI surface map

| Tab (settings modal)                                                                   | Implementation                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Chat**                                                                               | `src/settings/v2/components/BasicSettings.tsx` (provider-key portion removed) |
| **BYOK** — central registry of providers + enrolled models                             | `src/modelManagement/ui/tabs/ByokPanel.tsx`                                   |
| **Agent** — OpenCode / Claude Code / Codex / Quick Chat sub-tabs                       | `src/settings/v3/tabs/AgentPanel.tsx`                                         |
| **Commands**                                                                           | existing v2 component                                                         |
| **Embedding** — semantic-search settings up top, embedding-model section at the bottom | `src/settings/v2/components/QASettings.tsx`                                   |
| **Advanced**, etc.                                                                     | existing v2 components                                                        |

| Modal                         | Implementation                                               |
| ----------------------------- | ------------------------------------------------------------ |
| Add Provider                  | `src/modelManagement/ui/dialogs/AddProviderDialog.tsx`       |
| Configure Provider (3 states) | `src/modelManagement/ui/dialogs/ConfigureProviderDialog.tsx` |
| Add Custom Model              | `src/modelManagement/ui/dialogs/AddCustomModelDialog.tsx`    |

The existing `src/settings/v2/components/BasicSettings.tsx` (model picker portion) and `ModelSettings.tsx` (chat half) are **deleted** at the end of M9. The v2 folder remains for `Chat` (renamed) and other untouched tabs.

> **Welcome modal is out of scope for this plan.** A first-run / empty-state onboarding entry point will be designed and shipped separately. The BYOK tab's empty state (§5.1) handles the "no providers yet" baseline.

### 5.1 BYOK panel layout (the global table)

The populated BYOK panel is **one global table** with provider section rows:

```
┌────────────────────────────────────────────────────────────────┐
│ BYOK              [↻ Refresh catalog] [Manage providers] [+Add]│
│ The central place to configure the providers and models you    │
│ bring to Copilot. OpenCode-bundled and Copilot Plus models are │
│ configured in the Agent → OpenCode sub-tab.                    │
│                                                                │
│ [🔍 Filter models…]  [All]  [local]  [≥ 200k ctx]              │
│                                                                │
│ ┌──────────────────────────────────────────────────────────┐   │
│ │       Model                          Meta                │   │
│ ├──────────────────────────────────────────────────────────┤   │
│ │ ▼ [An] Anthropic       4 models   [⚙ Configure]    ⋯    │   │
│ │       Claude Sonnet 4.5            200k                 │   │
│ │       Claude Opus 4.1              200k                 │   │
│ │       Claude Haiku 4.5             200k                 │   │
│ │       Claude Sonnet 3.7            200k                 │   │
│ │ ▶ [Op] OpenAI          3 models   [⚙ Configure]    ⋯    │   │
│ │ ▼ [Ol] Ollama (local)  2 models   [custom endpoint] [⚙][⋯]│
│ │       llama3.2                     local · 8B           │   │
│ │       qwen2.5-coder                local · 7B           │   │
│ └──────────────────────────────────────────────────────────┘   │
│                                                                │
│ 9 enabled across 3 providers · 87 available in catalog         │
└────────────────────────────────────────────────────────────────┘
```

Key properties:

- **OpenCode-bundled and Copilot Plus models do NOT appear here.** They live in the Agent → OpenCode sub-tab. The description copy at the top makes this explicit.
- **Provider section rows** are styled headers inside one continuous table. Click chevron to fold/unfold.
- **Per-provider actions** on the right of each section row: `[⚙ Configure]` ghost button + `⋯` kebab (menu has ONE option: **Remove provider**).
- **Custom endpoints** (Ollama) show a `custom endpoint` badge alongside their actions.
- **Model rows have no checkbox, no kebab, no badges**. Just `Model name` + `Meta` (context window, "local · 8B", etc.). Model rows are display-only — to change which models are registered, open Configure Provider.
- **Filter bar:** Search + `All` / `local` / `≥ 200k ctx` chips. **No** Vision / Reasoning / Tool use chips.
- **Top-right header buttons:** `[↻ Refresh catalog]` (ghost, with last-fetched timestamp tooltip) + `[Manage providers]` (ghost) + `[+ Add provider]` (primary).
- **Catalog load timing:** On first BYOK-tab open in a session, the panel awaits `ModelCatalogService.ensureLoaded()` (renders a skeleton during the load — usually <50ms since it's just a disk read). If `getMeta().fetchedAt` is older than 24h or the catalog is empty (no disk cache), also kicks off a `refresh()`.

### 5.2 Configure Provider dialog (3 states)

Header: provider glyph + name. Edit state shows a `✓ Verified` badge after a successful key test.

Fields, all states:

- **API key** — editable text field (mono). `[Test]` button. In edit state, the field is **directly editable** (no "Replace" button); existing value shows masked dots.
- **Base URL** — editable in `new-custom`, read-only in `new-byok` / `edit`.

Custom-only extras (top of dialog, above API key):

- **Display name** — user-set label.
- **Type** — radio: OpenAI-compatible / Anthropic / Google.

**No Availability row.** No `chat / agent / mobile` checkboxes anywhere. (Confirmed against `final.jsx` lines 230-250.)

Models section header:

- Title: just **"Models"** (no subtitle like "GET /models → 6 found").
- Right side: `[+ Add from catalog]` (edit only) + `[+ Add custom model]`.

Filter bar above the model list:

- Search input
- Chips: `All`, `≥ 200k ctx`, `≤ $1/M`, `Released ≤ 6mo`. **No Vision / Reasoning / Tool use chips.**

Model picker rows (catalog list):

- Checkbox + model name + meta (context) + release date column (right-aligned, e.g. "Sep 2025")
- In edit state, registered models also show a `⋯` kebab with `View docs` / `Remove from registry`.

Footer:

- New states: `[Cancel]` `[Verify & save]`.
- Edit state: `[Remove provider]` (ghost danger, left) · `[Cancel]` `[Save changes]`.

### 5.3 Add Custom Model dialog

```
┌──────────────────────────────────────────────────────────┐
│ [An] Add custom model · under Anthropic              ✕   │
│ Use this for preview models, fine-tunes, private deploy- │
│ ments, or anything not in the catalog. Provider's        │
│ connection (key, base URL) is reused.                    │
│                                                          │
│ Display name      [Claude Sonnet 4.5 (preview)        ]  │
│ Model ID          [claude-sonnet-4-5-20260601-preview ]  │
│                                                  [Test] │
│                                                          │
│ Test once before saving — minimal "ping" request.        │
│                                          [Cancel] [Add]  │
└──────────────────────────────────────────────────────────┘
```

Fields: **Display name, Model ID. That's it.** No Capabilities checkboxes. No Availability row. No context window. No capabilities are stored on registry entries.

### 5.4 Agent panel layout

Top sub-tab strip (in order): **OpenCode · Claude Code · Codex · Quick chat**. Quick chat is **last** (lowest priority — it's the smallest of the four backends).

Each sub-tab includes:

- **Status card** — version, binary path, `[Use this backend]`, `[Reinstall]`, `[Browse…]`. Three states: `✓ Active backend` / `○ Configured, not active` / `⚠ Not installed`.
- **Models in this backend's picker** — list of registry models the user can check/uncheck to control which surface in the in-session picker. Header has a `Manage in BYOK →` link to the canonical registry. Sub-text under the section title: _"tick which models show up when you switch model mid-session"_.

> Per-backend "Default model" + "Default reasoning effort" were dropped — new sessions inherit (model, effort) from the previous active session on the same backend via `AgentSessionManager.getLastSelection`, falling back to the backend's catalog default. The in-memory map is wiped on plugin reload.

#### 5.4.1 OpenCode sub-tab

- **Picker section is a UNION of three sources** (per §2.2):
  1. OpenCode's enumerated bundled models (Big Pickle, etc.) — keys are the bare wire-form `baseModelId` (e.g. `bigpickle/big-pickle`).
  2. Copilot-Plus hosted models (when Plus license active) — keys `copilot-plus/<modelId>` (wire form).
  3. BYOK registry entries — keys are the wire form `<providerId>/<modelId>` (e.g. `anthropic/claude-sonnet-4-5`).
- These are merged at render time, never written to the BYOK `registry`. A subtle visual divider in the picker section groups them (OpenCode-bundled, then Plus, then BYOK).
- No `★ default` column (default is set via the dropdown above).
- "OpenCode not installed" empty-state when source #1 is unavailable.

#### 5.4.2 Claude Code / Codex sub-tabs

- Subscription card — `Authenticated as <email>` + `[Re-authenticate]`. Unauthenticated state: `⚠ Not signed in`.
- Picker section sources from the backend's **bundled** model list (not the BYOK registry — these backends are subscription-bound).

#### 5.4.3 Quick chat sub-tab

- Picker section sources from `EnrollmentRegistry.list()` filtered by `ProviderType.pipelines.langchain`, persisted through `consumers["quick-chat"]`.
- Implementation is a **placeholder** in this plan (UI shell + persistence wiring only). The complete wiring of "user picks a Quick-Chat-curated model in the chat input → LangChain chat fires in the new chat view" is the subject of the follow-up doc (`designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`).

---

## 6. Implementation Milestones

Each milestone is independently shippable and verifiable. Verification = unit tests + a short manual checklist the implementing agent can execute.

> **Convention for the implementing agent:** Before starting any milestone, run `npm run lint` and `npm run test` to ensure baseline passes. At end of each milestone, run both again — they must still pass.

---

### M1 — Module skeleton + catalog (lazy, BYOK-tab-triggered)

**Goal:** Establish the `src/modelManagement/` module with its public API + eslint boundary, plus `ModelCatalogService` with lazy fetching.

**Deliverables:**

- **Module skeleton:**
  - `src/modelManagement/index.ts` with the public API barrel per §3.0.
  - `src/modelManagement/types.ts` with `ProviderInstance`, `ByokEnrollment`, `InstanceId`, etc.
  - `src/modelManagement/providers/supportedProviders.ts` — `SUPPORTED_PROVIDER_IDS` constant per §1.2.
  - ESLint configuration: add `import/no-restricted-paths` rule per §3.0. Verify a deliberate violation (an import of `src/modelManagement/catalog/ModelCatalogService` from anywhere outside the module) fails `npm run lint`.
- **Catalog:**
  - `src/modelManagement/catalog/modelsCatalog.types.ts` — types from §1.3.
  - `src/modelManagement/catalog/ModelCatalogService.ts` — **lazy** two-tier read path (no plugin-onload fetch):
    - `ensureLoaded()`: on first call, read disk cache; if missing, leave memory empty until a successful `refresh()`. Memory cache after that.
    - `refresh()`: triggers live fetch (5s timeout), writes disk on success, emits change.
    - Disk cache path: resolve via `app.vault.adapter` + `manifest.dir`; file is `.modelsCatalogCache.json` with `{ fetchedAt, data }` structure.
    - No `setOpenCodeSource` (removed per §1.4).
- Unit tests in `src/modelManagement/catalog/__tests__/ModelCatalogService.test.ts`:
  - `ensureLoaded()` is idempotent and lazy (no fetch happens until `refresh()` is called or invoked manually).
  - Two-tier behavior (no disk cache → empty memory; live fetch failure → keeps last loaded).
  - `refresh()` triggers fetch + disk write + change event.
  - Filter behavior (`contextAtLeast`, `maxCostPerMillion`, `releasedWithinMonths`).

**Agent verification checklist:**

1. `npm run test -- ModelCatalogService` — all green.
2. `npm run lint` — clean. Then add a deliberate `import { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService"` in `src/main.ts` → `npm run lint` should report a boundary violation. Revert.
3. Manual smoke (load plugin):
   - Open Settings → non-model tabs work normally; plugin onload **does not** trigger any models.dev request (verify via dev-tools network panel).
   - `ModelCatalogService.getInstance().getMeta()` returns `{ fetchedAt: null, source: null }` until something invokes `ensureLoaded()`.
   - Calling `ensureLoaded()` (e.g. via a temporary dev command) reads disk cache or leaves memory empty; calling `refresh()` triggers a live fetch and updates disk + memory.

**Out of scope:** No UI consumes the catalog yet beyond a dev-mode smoke logger; lazy hook into BYOK tab open is wired in M4.

---

### M2 — Schema, migration, and service skeleton

**Goal:** Introduce `settingsVersion`, `providers`, `enrollments`, `consumers`; write v0 → v2 migration; refactor `ChatModelManager` to read the new shape. After this milestone the plugin behaves identically to before from the user's perspective — only the internal data layout has changed.

**Deliverables:**

- `src/settings/model.ts` — slimmed to schema only. Re-exports `ProviderInstance` / `ByokEnrollment` / `ConsumerConfig` / `InstanceId` / `ProviderTypeId` etc. from `@/modelManagement`. Add `settingsVersion`, `providers`, `enrollments`, `consumers`, `_migrationBreadcrumbs`, `_migrationNoticeDismissed` fields. Remove the legacy provider-key fields, `defaultModelKey`, the global chat knobs (`temperature` / `maxTokens` / `reasoningEffort` / `verbosity` / `topP` / `frequencyPenalty`), and `agentMode.enabled` from the interface. Add `agentMode.backends.quickChat` skeleton type.
- `src/modelManagement/migrations/runMigrations.ts` + `v0-to-v2.ts` — runner + v0→v2 implementation per §4.2. **Migration must run synchronously** — it cannot await the catalog service. It does not read the catalog at all; enrollments are built from v0 data alone (no capability inference, no `contextWindow` / `releaseDate` enrichment).
- `src/modelManagement/providers/ProviderRegistry.ts`, `src/modelManagement/registry/EnrollmentRegistry.ts`, `src/modelManagement/consumers/ConsumerRegistry.ts` — full implementations per §3.1-3.3.
- `src/modelManagement/providers/adapters/` — adapter classes, one per `AdapterKind`. Each adapter file exports `buildLangChainClient(...)` + `extraSchema: z.ZodSchema` per §3.7. `index.ts` exposes the adapter registry keyed by `AdapterKind`.
- `src/modelManagement/chatModel/ChatModelManager.ts` — reads `ProviderRegistry` + `EnrollmentRegistry` only; consults the adapter registry for instantiation.
- `src/modelManagement/chatModel/buildLangChainConfig.ts` — pure helper + unit tests.
- Migration notice toast (§4.4) wired in `main.ts` `onload` after settings load.
- Dev command `Copilot: Show settings migration status` registered.
- `src/modelManagement/migrations/__tests__/v0-to-v2.test.ts` — fixture-based tests:
  - Fresh install (empty settings) → `settingsVersion = 2`, `providers = {}`, `enrollments = []`, `consumers` populated with empty `enabledModels: []` for each LangChain consumer.
  - Settings with only the OpenAI key (no `activeModels`) → one `ProviderInstance`, no enrollments.
  - Settings with `activeModels` containing only built-in entries and **no** provider keys → `providers = {}`, `enrollments = []` (every built-in dropped; breadcrumb logged).
  - Settings with OpenAI key + built-in entries from Anthropic, Google, OpenAI → only the OpenAI built-ins migrate; Anthropic + Google built-ins dropped; breadcrumb lists them.
  - Settings with a mix of built-in + custom + Ollama → providers + enrollments split correctly; Ollama-side enrollments carry `declaredContextLimit` / `declaredCapabilities`; embedding models stay in `activeEmbeddingModels`.
  - Settings with per-model chat-tuning overrides → dropped, breadcrumbs populated.
  - Settings with adapter knobs (`numCtx`, `enablePromptCaching`, `enableCors`) → migrated to `ByokEnrollment.overrides`.
  - Settings with `activeModels[*].enabled = false` → entry dropped, breadcrumb logged.
  - Settings with `agentMode.backends.<id>.modelEnabledOverrides` → translated into `consumers["agent:<id>"].enabledModels` with `ConsumerModelRef` per source; orphan keys dropped to breadcrumbs.
  - Settings with `defaultModelKey = "claude-sonnet-4-5|anthropic"` → resolves to an enrollment and seeds `consumers["chat"].defaultModel` (plus the other LangChain consumers for continuity).
  - Settings with `activeModels` containing OpenCode-bundled / Plus models → never enter `enrollments`; reach `consumers["agent:opencode"].enabledModels` as `{ source: "backend-bundled" }` / `{ source: "copilot-plus" }`.
  - Corrupt / empty input → migration falls back gracefully (see §4.3).
  - Idempotency: running migration twice produces the same output.

**Agent verification checklist:**

1. `npm run test -- migrations` — fixtures green.
2. Run `npm run build` then load plugin in test vault with a pre-existing `data.json` (seed via `git stash` or fixture); verify:
   - Notice toast appears once.
   - Existing v2 Chat tab still renders, showing the chat-input model picker resolved through the new shape.
   - Chat works — pick a model in chat input, send a message, get a response.
   - Restart plugin → toast does NOT reappear.
3. Run `Copilot: Show settings migration status` command → modal shows breadcrumb with `from: 0, to: 2`.
4. Garbage `data.json` → safety net catches it (§4.3); toast says "Couldn't upgrade", plugin still works in degraded mode.
5. Manual screenshot before/after — chat-input model picker still shows correct selection.

**Risk:** Any consumer outside `ChatModelManager` that reads `settings.openAIApiKey` etc. directly will break. **Pre-flight grep** (see Appendix A) and update each call site to read from `ProviderRegistry`.

---

### M3 — Embedding tab carries the embedding-model section

**Goal:** Move the embedding-model section into the Embedding tab at the bottom, alongside the existing semantic-search settings.

**Deliverables:**

- `src/settings/v2/components/QASettings.tsx` — semantic-search settings up top; **new section at the bottom**: heading "Embedding models" + the embedding-model table (extracted into `EmbeddingModelsSection.tsx`). Same add/edit/delete flows, same `activeEmbeddingModels` field, same existing dialog components. Tab label is **"Embedding"**.
- `src/settings/v2/components/EmbeddingModelsSection.tsx` — extracted table component.
- `src/settings/v2/components/ModelSettings.tsx` — embedding portion removed.
- `src/settings/v2/SettingsMainV2.tsx` — tab label "Embedding"; tab order unchanged.
- Snapshot tests for the Embedding tab.

**Agent verification checklist:**

1. Open settings → tab strip shows "Embedding".
2. Open Embedding tab → semantic-search settings at the top, embedding-models table at the bottom.
3. Embedding-model add / edit / delete / toggle flows all work; vector-store rebuild still works (trigger via existing command).
4. No other settings tabs moved or renamed.

---

### M4 — BYOK panel (global table + provider sections)

**Goal:** Implement the BYOK tab as one global table with provider section rows.

**Deliverables:**

- `src/modelManagement/ui/tabs/ByokPanel.tsx`:
  - **On mount**: `await ModelCatalogService.getInstance().ensureLoaded()` (skeleton during load); then if `getMeta().fetchedAt < Date.now() - 24h`, fire-and-forget `refresh()`.
  - Empty state with `[+ Add provider]`.
  - Populated state with one global table per §5.1.
  - Header: title + description copy per §5.1 + `[↻ Refresh catalog]` (with last-fetched timestamp tooltip) + `[Manage providers]` + `[+ Add provider]`.
  - Filter bar: search input + `All` / `local` / `≥ 200k ctx` chips (no capability chips).
  - Footer: `<N> enrolled across <M> providers · <K> available in catalog`.
- `src/modelManagement/ui/components/ByokGlobalTable.tsx` — one global table component handling provider section rows + indented model rows:
  - Provider section row: chevron · glyph · `ProviderInstance.displayName` · enrollment count · badge (`custom endpoint` if the provider type has no catalog) · `[⚙ Configure]` (ghost) · `⋯` (kebab → single "Remove provider" item).
  - Model rows: `Model name` + `Meta` only. No checkbox. No kebab. No badges.
  - Foldable per provider instance (default: open; remembers state per `instanceId`).
- `src/settings/v2/SettingsMainV2.tsx` — register the BYOK tab.
- Mobile rendering: `useIsMobile()` hook adapts header copy and stacks controls.
- Tests: snapshot for populated/empty states; interaction tests for fold/unfold and Remove provider confirm; verify `ensureLoaded` runs on mount and `refresh()` fires only when stale.

**Agent verification checklist:**

1. Open settings → BYOK tab visible. Plugin reload + open Settings (without visiting BYOK) makes zero models.dev requests.
2. **First-time BYOK tab open**: skeleton briefly visible → `ensureLoaded()` resolves → table populates. Second open in the same session is instant (memory cache).
3. With migrated data: table populated with provider section rows; counts match `EnrollmentRegistry.list({ instanceId }).length`; model rows are display-only.
4. **No OpenCode or Copilot Plus rows in BYOK**, ever. Even when OpenCode is running, only BYOK providers (Anthropic / OpenAI / Ollama / etc.) appear.
5. With two `ProviderInstance` rows of the same `providerTypeId`, both render as distinct sections (display names disambiguate).
6. Click chevron → section folds; click again → unfolds. State persists across modal open/close.
7. Provider section kebab → Remove provider → confirm → all that instance's enrollments disappear; restart plugin → still gone.
8. Click `[⚙ Configure]` on a provider section → opens Configure Provider dialog targeting that `instanceId` (full flow lands in M5).
9. Click `[↻ Refresh catalog]` → spinner → timestamp updates; rows show any newly-released models.
10. Filter bar: type "claude" → only Anthropic section + Claude rows show; click `local` chip → filters to Ollama; clear → all sections back.

---

### M5 — Configure Provider + Add Provider + Add Custom Model dialogs

**Goal:** All three dialogs from §5.2 / §5.3, wired into the BYOK tab.

**Deliverables:**

- `src/modelManagement/ui/dialogs/AddProviderDialog.tsx`:
  - Provider type picker with `Recommended` (Anthropic / OpenAI / Google) + `More providers` (alphabetical).
  - "Add a custom provider" CTA card at the bottom (dashed border, accent tint per the design).
  - **No filter on already-added types.** Multi-instance is a first-class flow.
- `src/modelManagement/ui/dialogs/ConfigureProviderDialog.tsx` — single component supporting `state: "new-byok" | "new-custom" | "edit"`. Always targets a single `instanceId` (or synthesizes one in the `new-*` states):
  - Header adapts (✓ Verified badge in edit state).
  - Connection fields with 120px label gutter. **No Availability row.**
  - Display name field — the UI suggests numbered/qualified defaults (e.g. `"Anthropic (prod)"`) when a sibling instance with the same `providerTypeId` already exists.
  - API key field directly editable in all states (no "Replace" button); `[Test]` button present.
  - Models section header: just "Models" subtitle; right side has `[+ Add from catalog]` (edit only) + `[+ Add custom model]`.
  - Filter bar: search + `All` / `≥ 200k ctx` / `≤ $1/M` / `Released ≤ 6mo` chips. **No Vision / Reasoning / Tool use chips.**
  - Model picker rows: checkbox + name + context + release date column. Edit state adds `⋯` kebab on enrolled rows (View docs / Remove enrollment).
  - Sticky upstream-provider headers for OpenRouter.
  - Footer adapts (edit: `[Remove provider]` left, `[Save changes]` right; new: `[Verify & save]` right with selection count left).
  - On save: writes to `ProviderRegistry` + `EnrollmentRegistry` scoped to the target `instanceId`; verification calls dispatched async, errors decorate rows with ⚠.
- `src/modelManagement/ui/dialogs/AddCustomModelDialog.tsx`:
  - Three fields: Display name, Model ID, Context window. **No Capabilities checkboxes. No Availability row.**
  - `[Test]` button next to Model ID.
  - On save: creates a `ByokEnrollment` whose `modelId` isn't in the instance's `ProviderType` catalog (so `isCustomModel` returns true). `Context window` writes to `declaredContextLimit`.
- `src/modelManagement/ui/components/ProviderCatalogList.tsx` — checklist used inside Configure Provider.
- BYOK `[⚙ Configure]` on a provider section → opens ConfigureProviderDialog in edit state for that `instanceId`.
- BYOK `[+ Add provider]` → AddProviderDialog → ConfigureProviderDialog in `new-byok` (or `new-custom`) state.
- Tests: each dialog's states; verification happy + error paths; OpenRouter sticky-header rendering; second-instance disambiguation.

**Agent verification checklist:**

1. From empty BYOK tab → `[+ Add provider]` → AddProviderDialog opens → pick Anthropic → ConfigureProviderDialog opens in `new-byok` state with API key focused.
2. Paste a real Anthropic key → click `[Test]` → ✓ within ~2s.
3. Recommended models pre-checked, release date visible on each → click `[Verify & save]` → dialog closes → Anthropic section + rows appear in BYOK table.
4. Chat with the new model — succeeds (proves the migration → service → ChatModelManager path).
5. Click `[⚙ Configure]` on the Anthropic section → edit state with all fields pre-filled and ✓ Verified badge. **No Availability row visible.** Key field is editable directly (no "Replace" button).
6. Click `[+ Add custom model]` → fields are only Display name / Model ID / Context window. Enter a preview model ID → `[Test]` → ✓ → Add → row appears in the table.
7. Add a custom Ollama provider (`http://localhost:11434/v1`) — discovered model list populates from `/models`; pick two → save → Ollama section appears with `custom endpoint` badge.
8. Add OpenRouter — sticky section headers visible per upstream provider; `≤ $1/M` filter chip works.
9. Configure Provider model picker: `Released ≤ 6mo` chip filters to recent models.

---

### M6 — Agent tab (with Quick Chat sub-tab skeleton)

**Goal:** The Agent tab per §5.4, including the Quick Chat sub-tab as a UI skeleton (persistence wired; chat-input → backend routing lives in the follow-up doc).

**Deliverables:**

- `src/settings/v3/tabs/AgentPanel.tsx` — top-level layout with `BackendSubtabs` and per-backend sub-panel.
- `src/settings/v3/components/BackendSubtabs.tsx` — four-way sub-tab strip (**OpenCode / Claude Code / Codex / Quick chat** — Quick chat last) with active-vs-viewed distinction.
- `src/settings/v3/components/BackendStatusCard.tsx` — shared status card with three states (`✓ Active backend` / `○ Configured, not active` / `⚠ Not installed`) and `[Use this backend]` / `[Reinstall]` / `[Browse…]` actions.
- `src/settings/v3/components/BackendModelPicker.tsx` — shared "Models in this backend's picker" component used by all four sub-tabs:
  - Header: title + sub-text ("tick which models show up when you switch model mid-session") + `Manage in BYOK →` link.
  - Rows: checkbox + name + provider instance display name (muted) + meta. No ★ default badge column.
  - Persists each tick/untick through `ConsumerRegistry.setEnabledModels("agent:<id>", refs)` (or `"quick-chat"` for Quick Chat).
- Per-backend sub-panels in `src/settings/v3/components/backends/`:
  - **OpencodePanel.tsx:** Status + BackendModelPicker sourced from `ConsumerRegistry.visibleEntries("agent:opencode")`.
  - **ClaudeCodePanel.tsx / CodexPanel.tsx:** Status + Subscription card (re-auth) + BackendModelPicker sourced from the backend's bundled model list, persisted through `consumers["agent:claude-code"]` / `consumers["agent:codex"]`.
  - **QuickChatPanel.tsx (skeleton):** Status (always "Active — runs in the plugin"; no install needed) + BackendModelPicker sourced from `EnrollmentRegistry.list()` filtered through `ProviderType.pipelines.langchain`. Persists through `consumers["quick-chat"]`. The chat-input → Quick Chat runtime routing is the follow-up doc's job.
- New sessions inherit (model, effort) from the previous active session on the same backend via `AgentSessionManager.getLastSelection`; on a fresh plugin load the manager falls back to the backend's catalog default. Picker selections feed `AgentSessionManager.rememberLastSelection` (in-memory, lost on reload), not `setSettings`.
- `src/settings/v2/SettingsMainV2.tsx` — Agent tab registration points at `AgentPanel`.
- Tests: tab switch preserves state; `[Use this backend]` updates `agentMode.activeBackend`; picker persistence writes through `ConsumerRegistry`.

**Agent verification checklist:**

1. Open Agent tab → 4 sub-tabs visible in order: OpenCode · Claude Code · Codex · Quick chat. OpenCode sub-tab active by default.
2. Status card shows correct state per backend.
3. Switch sub-tabs → panel changes; each preserves its own state.
4. Click `[Use this backend]` in Claude Code's status card → it becomes active; OpenCode flips to `○ Configured`.
5. OpenCode picker: tick/untick a model → reload plugin → state persists in `consumers["agent:opencode"].enabledModels`; chat input agent picker reflects.
6. Quick chat sub-tab: status card says active; picker lists all `pipelines.langchain` enrollments. Tick some models → save → restart → `consumers["quick-chat"].enabledModels` persists. Chat input routing is the follow-up doc's territory.

---

### M7 — _(reserved — Welcome modal lives in a separate workstream)_

The BYOK tab's empty state (one big `[+ Add provider]` CTA per §5.1) is the only first-run surface this plan ships. Milestone numbers M8/M9 are unchanged.

---

### M8 — BYOK → OpenCode bridge + OpenCode panel model sources

> **SUPERSEDED / LANDED.** The _intent_ of M8 (BYOK providers usable in agent
> mode; opencode panel unions BYOK + bundled + Plus sources) shipped via
> `agent_model_curation_migration.md` (M1–M5, landed), but the **mechanics below
> are superseded**: the shipped code uses `origin`-based `Provider` +
> `ConfiguredModel` + `BackendConfigRegistry` + `backends.opencode.enabledModels`,
> not the `ProviderInstance` / `instanceId` / `EnrollmentRegistry` /
> `consumers[...]` / `source`-tagged refs named here (those never existed in the
> codebase). Read the curation-migration doc for the shipped design; the file
> names below (`byokBridge.ts`, `bundledModels.ts`, `plusModels.ts`,
> `OpencodePanel.tsx`) did not land as written.

**Goal:** BYOK providers usable in agent mode, and the OpenCode sub-tab's three-source picker (OpenCode-bundled ⊕ Copilot Plus ⊕ BYOK). **OpenCode-bundled and Copilot Plus models stay out of the BYOK panel entirely.**

**Deliverables:**

- `src/agentMode/backends/opencode/byokBridge.ts` — on OpenCode startup (and on `ProviderRegistry` changes), register every `ProviderInstance` whose `ProviderType.pipelines.opencode === true` into OpenCode's config. Bridged-provider id is derived from `instanceId`, so two `ProviderInstance` rows of the same `providerTypeId` register distinctly. Instances whose `pipelines.opencode` is false are skipped (surfaced in BYOK panel as ineligible-for-OpenCode).
- `src/agentMode/backends/opencode/bundledModels.ts` — sync wrapper exposing OpenCode's bundled-model enumeration via `listBundledModels(): Promise<BundledModel[]>`. Reads from the running OpenCode binary's JSON-RPC or config.
- `src/agentMode/backends/opencode/plusModels.ts` — same shape for Copilot Plus hosted models; gated by `isPlusUser`.
- `src/settings/v3/components/backends/OpencodePanel.tsx` — `BackendModelPicker` displays three sources unioned:
  1. `listBundledModels()` rows (header: "OpenCode-bundled") — refs of `source: "backend-bundled", backendId: "opencode"`.
  2. `listPlusModels()` rows (header: "Copilot Plus", only when Plus active) — refs of `source: "copilot-plus"`.
  3. `EnrollmentRegistry.list()` rows filtered by `ProviderType.pipelines.opencode` (header: "From BYOK") — refs of `source: "byok"`.
     Each row's checkbox flips inclusion in `consumers["agent:opencode"].enabledModels`. The wire form OpenCode speaks at runtime is derived per source — bundled keeps its `bigpickle/...` form, Plus uses `copilot-plus/<modelId>`, BYOK uses `<bridgedInstanceId>/<modelId>`. The runtime picker reconciles each ref against `BackendInventory["opencode"]` at render time.
     "OpenCode not installed" empty-state replaces source #1 when unavailable; sources #2 / #3 still render.
- Tests: bridge round-trip (BYOK custom provider → OpenCode config file → readable back); OpenCode panel renders all three sources correctly when present; missing sources hide their section header; `pipelines.opencode === false` enrollments don't reach the panel.

**Agent verification checklist:**

1. Add a local Ollama provider via BYOK → check OpenCode's config dir contains an entry for it keyed by `instanceId`. Ollama row appears in the OpenCode panel's "From BYOK" section.
2. Start an agent session in OpenCode → Ollama model appears in the in-session model picker → can execute a task using it.
3. With OpenCode running: OpenCode panel shows three sections (Bundled / Plus if applicable / From BYOK); BYOK tab shows **no** OpenCode rows.
4. Add two Anthropic `ProviderInstance` rows ("prod" and "staging") → both surface as separate rows in the OpenCode panel's "From BYOK" section, disambiguated by display name.
5. Stop OpenCode → "OpenCode not installed" empty-state replaces the Bundled section; BYOK section still renders.
6. With Plus license active: Plus section appears.

---

### M9 — Cleanup + final removals

> **PARTIALLY LANDED.** The agent-curation slice of cleanup landed via
> `agent_model_curation_migration.md` M5: the legacy `activeModels` /
> `plusLicenseKey` / `modelEnabledOverrides` agent paths are removed (the last is
> retained only as a deprecated, migration-only read field that drains after a
> one-time seed). The **chat-mode** removals listed below (`ModelSettings.tsx`,
> `BasicSettings.tsx` picker portion, etc.) remain future work — tracked in
> `models_management_redesign_cleanup.md`.

**Goal:** Delete legacy code paths, finalize tab labels, update docs.

**Deliverables:**

- Delete `src/settings/v2/components/ModelSettings.tsx`, `ModelAddDialog.tsx`, `ModelEditDialog.tsx`, `ModelParametersEditor.tsx`, and the model-picker portion of `BasicSettings.tsx`.
- Delete the legacy provider-key field references throughout the codebase (run grep from Appendix A; nothing should match).
- `src/settings/v2/SettingsMainV2.tsx` — tab labels: Chat · BYOK · Agent · Commands · Embedding · Advanced.
- `src/constants.ts` — `BUILTIN_CHAT_MODELS` removed (catalog replaces it). `BUILTIN_EMBEDDING_MODELS` kept (embedding side is unchanged by this redesign).
- Delete `src/LLMProviders/` (its contents are inside `src/modelManagement/` now).
- Remove the `ChatDefaults` type and the `temperature` / `maxTokens` / `reasoningEffort` / `verbosity` / `topP` / `frequencyPenalty` fields throughout the codebase.
- Update user-facing docs (`docs/llm-providers.md`, `docs/agent-mode-and-tools.md`) per the new UI.
- Update `AGENTS.md` migration notes section.
- Final `npm run lint && npm run format && npm run test && npm run build` pass clean.

**Agent verification checklist:**

1. `git grep openAIApiKey src/` returns nothing.
2. `git grep activeModels src/` only returns `activeEmbeddingModels` references.
3. `git grep BUILTIN_CHAT_MODELS src/` returns nothing.
4. `git grep ChatDefaults src/` returns nothing.
5. `src/LLMProviders/` no longer exists.
6. Tab strip shows: Chat · BYOK · Agent · Commands · Embedding · Advanced.
7. `npm run lint && npm run test && npm run build` all green.
8. Manual smoke test:
   - Fresh install → BYOK empty state → `[+ Add provider]` → add provider → chat works.
   - Add custom Ollama → agent mode works in OpenCode.
   - Switch agent backend to Claude Code → agent session works.
   - Embedding tab → rebuild vector index → semantic search works.

---

## 7. Cross-cutting verification artifacts

The implementing agent should maintain a `TODO.md` per `AGENTS.md` guidance for session-level tracking, plus produce these artifacts as deliverables of the whole series:

- `designdocs/MODEL_MANAGEMENT_IMPLEMENTATION_PROGRESS.md` — checked off as each milestone completes.
- Screenshots before/after each milestone (saved to `.context/screenshots/M<n>/`).
- Migration test fixtures under `src/modelManagement/migrations/__tests__/fixtures/`:
  - `fixture-keys-only.json` — only provider keys.
  - `fixture-custom-provider-ollama.json` — local Ollama with two models.
  - `fixture-agent-overrides.json` — `modelEnabledOverrides` populated with old-format keys.
  - `fixture-overrides-everywhere.json` — every per-model override field set, plus `enabled: false`.
  - `fixture-azure-bedrock.json` — Azure + Bedrock with their extras.
  - `fixture-default-model-key.json` — `defaultModelKey` populated; verifies seeding of LangChain `consumers[*].defaultModel`.

---

## 8. Risks & known unknowns

| Risk                                                                | Mitigation                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models.dev/api.json` schema drift between runtime fetches          | Hand-rolled `.d.ts` + runtime Zod validation in `ModelCatalogService.refresh()`. Bad payload → log + keep last good source.                                                                                        |
| `models.dev` outage or CORS issue from Obsidian's environment       | Disk cache covers outage once we've fetched at least once; lazy fetch means most sessions never call out at all. CORS not a concern (Obsidian uses Node `fetch`).                                                  |
| Boundary eslint rule false positives                                | Add narrow `import/no-restricted-paths` allowances for files that legitimately bridge boundaries (`src/main.ts`); review allowances during M9.                                                                     |
| OpenCode bundled / Plus model enumeration API changes               | `bundledModels.ts` + `plusModels.ts` are the only consumers; isolated in the OpenCode backend folder.                                                                                                              |
| Migration on corrupt data.json                                      | Safety net in `runMigrations` — degrade gracefully.                                                                                                                                                                |
| Keychain unavailability on older Obsidian                           | Existing `_keychainOnly` flag respected; falls back to inline keys.                                                                                                                                                |
| Per-model `numCtx` (Ollama) drop breaks user setups                 | Defaults are reasonable; documented in toast.                                                                                                                                                                      |
| Plus license check timing during M8                                 | Existing `isPlusUser` reactive; OpenCode panel re-renders its "Copilot Plus" section when the flag flips.                                                                                                          |
| Quick Chat skeleton doesn't actually route the user's chat input    | Documented as "skeleton — follow-up doc completes it." Settings persist but runtime routing is unchanged until the follow-up ships.                                                                                |
| Provider `extra` opaqueness lets bad payloads sneak past TypeScript | Each adapter's `extraSchema.parse(...)` is called at instantiation time; failure surfaces as a `lastVerificationError` on the provider. Migration also runs schemas to validate carried-over Azure/Bedrock extras. |

---

## 9. Follow-up scope (out of this plan)

The Quick Chat agent backend, end-to-end:

- Chat input model picker integration (which backend gets invoked when a model is picked).
- LangChain chat as a first-class agent backend (session API parity with OpenCode et al.).
- New chat view bindings for the Quick Chat agent.
- Migration / runtime resolution rules when a model belongs to multiple backends' pickers.

→ **`designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`** (created alongside this plan; see that doc for design + milestones).

The Quick Chat sub-tab in M6 is a **skeleton** — UI shell and persistence only. The follow-up doc owns runtime routing and the new chat view.

---

## Appendix A — Pre-flight grep targets

Run these before starting M2 to map every legacy field consumer that needs updating to read via `ProviderRegistry`:

```
git grep -nE '(openAIApiKey|openAIOrgId|anthropicApiKey|googleApiKey|cohereApiKey|mistralApiKey|deepseekApiKey|groqApiKey|xaiApiKey|openRouterAiApiKey|siliconflowApiKey|amazonBedrockApiKey|amazonBedrockRegion|huggingfaceApiKey|azureOpenAI\w+|openAIProxyBaseUrl|openAIEmbeddingProxyBaseUrl|defaultModelKey|activeModels|agentMode\.enabled)' -- 'src/**'
```

Every match outside `src/settings/migrations/`, `src/settings/model.ts` (the type definition), and `src/services/ProviderRegistry.ts` is a call site to update.

---

## Appendix B — Final file inventory

| New files (M1–M9)                                                                                     | Purpose                                               |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/modelManagement/index.ts`                                                                        | M1 public API barrel (single entry point)             |
| `src/modelManagement/types.ts`                                                                        | M1 shared types (ProviderInstance, ByokEnrollment, …) |
| `src/modelManagement/providers/supportedProviders.ts`                                                 | M1 `SUPPORTED_PROVIDER_IDS`                           |
| `src/modelManagement/catalog/modelsCatalog.types.ts`                                                  | M1 catalog types                                      |
| `src/modelManagement/catalog/ModelCatalogService.ts`                                                  | M1 (lazy + 2-tier: memory → disk → live)              |
| ESLint config additions (`import/no-restricted-paths`)                                                | M1 boundary enforcement                               |
| `src/modelManagement/migrations/runMigrations.ts`                                                     | M2                                                    |
| `src/modelManagement/migrations/v0-to-v2.ts`                                                          | M2                                                    |
| `src/modelManagement/migrations/__tests__/v0-to-v2.test.ts` + fixtures                                | M2                                                    |
| `src/modelManagement/providers/ProviderRegistry.ts`                                                   | M2                                                    |
| `src/modelManagement/providers/adapters/*` (relocated from `src/LLMProviders/`)                       | M2                                                    |
| `src/modelManagement/registry/EnrollmentRegistry.ts`                                                  | M2                                                    |
| `src/modelManagement/consumers/ConsumerRegistry.ts`                                                   | M2                                                    |
| `src/modelManagement/chatModel/ChatModelManager.ts`                                                   | M2 (refactored from src/LLMProviders)                 |
| `src/modelManagement/chatModel/buildLangChainConfig.ts`                                               | M2                                                    |
| `src/settings/v2/components/EmbeddingModelsSection.tsx` (extracted from ModelSettings)                | M3                                                    |
| `src/modelManagement/ui/tabs/ByokPanel.tsx`                                                           | M4                                                    |
| `src/modelManagement/ui/components/ByokGlobalTable.tsx`                                               | M4                                                    |
| `src/modelManagement/ui/dialogs/{AddProviderDialog,ConfigureProviderDialog,AddCustomModelDialog}.tsx` | M5                                                    |
| `src/modelManagement/ui/components/ProviderCatalogList.tsx`                                           | M5                                                    |
| `src/settings/v3/tabs/AgentPanel.tsx`                                                                 | M6                                                    |
| `src/settings/v3/components/{BackendSubtabs,BackendStatusCard,BackendModelPicker}.tsx`                | M6                                                    |
| `src/settings/v3/components/backends/{Opencode,ClaudeCode,Codex,QuickChat}Panel.tsx`                  | M6                                                    |
| `src/agentMode/backends/opencode/byokBridge.ts`                                                       | M8                                                    |
| `src/agentMode/backends/opencode/bundledModels.ts`                                                    | M8                                                    |
| `src/agentMode/backends/opencode/plusModels.ts`                                                       | M8                                                    |
| `designdocs/MODEL_MANAGEMENT_IMPLEMENTATION_PROGRESS.md`                                              | Tracking artifact                                     |

| Deleted files (M9)                                                     | Reason                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/settings/v2/components/ModelSettings.tsx`                         | Replaced by ByokPanel + EmbeddingsPanel                                     |
| `src/settings/v2/components/ModelAddDialog.tsx`                        | Replaced by AddCustomModelDialog                                            |
| `src/settings/v2/components/ModelEditDialog.tsx`                       | Replaced by ConfigureProviderDialog                                         |
| Provider-key portion of `src/settings/v2/components/BasicSettings.tsx` | Replaced by ConfigureProviderDialog                                         |
| `src/LLMProviders/` (entire folder)                                    | Relocated to `src/modelManagement/providers/adapters/` + `chatModel/` in M2 |
| `BUILTIN_CHAT_MODELS` block of `src/constants.ts`                      | Replaced by `ModelCatalogService` (lazy live fetch + disk cache)            |

---

## Appendix C — Related docs

- **`designdocs/MODEL_DATA_MODEL_SPEC.md`** — canonical data model (entities, settings shape, invariants, resolution traces).
- **`designdocs/MODEL_MANAGEMENT_REDESIGN.md`** — product / UX spec.
- **`designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`** — Quick Chat agent backend runtime + chat-input routing.
