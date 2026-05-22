# Model Management Redesign — Technical Design & Implementation Plan

> **Companion to:** `designdocs/MODEL_MANAGEMENT_REDESIGN.md` (product / UX spec).
> **This doc owns:** library choice, data model, migration strategy, code-architecture changes, milestone breakdown with verification checklists.
> **Audience:** A background implementation agent. Each milestone is self-contained and verifiable without human approval.
> **Status:** Updated 2026-05-20 (rev 3) — reflects the latest design bundle (`copilot-model-settings/project/screens/final.jsx`) and additional scope decisions:
>
> - BYOK is the central registry for _user-brought_ keys only (no built-in models, no OpenCode/Plus models).
> - Removal of all per-model and per-provider "Availability" / "Capability" toggles; model rows are display-only inside one global table.
> - Quick Chat as a fourth agent sub-tab (skeleton only; routing in the follow-up doc).
> - Lazy `models.dev` fetching (BYOK-tab-triggered, not on plugin boot).
> - `src/modelManagement/` module with enforced import boundary.
> - **Built-in models are eliminated** — migration drops any built-in `activeModels` entry whose provider lacks a configured API key; built-in entries with a key migrate as ordinary registry entries.
> - **Embedding models move to a renamed "Embedding" tab** (was "QA"); other QA settings stay where they are, embedding section sits at the bottom. No separate Embeddings tab.
> - **Welcome modal is out of scope** for this plan.

---

## 0. Context

The current model management implementation has three duplicated UI surfaces (Basic Settings provider keys, Models Settings table, Agent Mode model curation), with provider API keys scattered as ~25 top-level fields on `CopilotSettings`, and `activeModels` doubling as both "enabled chat models" and "API credential carrier". The redesign (`MODEL_MANAGEMENT_REDESIGN.md`) consolidates this into a single **BYOK** tab + dedicated **Agent** tab, backed by a unified provider registry and a live `models.dev` catalog.

**BYOK is the central place to configure the _new_ keys and models a user brings to Copilot** (Anthropic / OpenAI / Google / Ollama / custom endpoints / etc). It is **not** a master list of every model the plugin can reach: OpenCode-bundled models (Big Pickle, …) and Copilot-Plus hosted models (Plus Flash, …) **never appear in BYOK**. Those live exclusively in the OpenCode sub-tab of the Agent panel. The BYOK description copy makes this explicit: _"The central place to configure the providers and models you bring to Copilot. OpenCode-bundled and Copilot Plus models are configured in the Agent → OpenCode sub-tab."_

Curation of which models surface in a specific agent's in-session picker is a per-agent concern that lives in the Agent tab.

This implementation plan also takes the opportunity to **separate concerns** that are currently tangled:

| Concern                                                 | Today                                                                                                               | After redesign                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credentials                                    | ~25 ad-hoc fields on `CopilotSettings` (`openAIApiKey`, `anthropicApiKey`, `amazonBedrockRegion`, …)                | One typed `providers: Record<ProviderId, ProviderConfig>` map                                                                                                                                         |
| Enabled models                                          | `activeModels: CustomModel[]` (also carries API keys, base URLs, per-model overrides)                               | One `registry: RegistryEntry[]` referencing provider by id                                                                                                                                            |
| Built-in catalog of pre-listed models                   | Hard-coded in `src/constants.ts` (`BUILTIN_CHAT_MODELS`) — pre-populated regardless of whether the user has the key | **Eliminated.** The registry contains _only_ models the user explicitly registered. Migration drops any pre-listed entry whose provider has no configured key (the user was never actually using it). |
| Available models per provider (for the picker)          | Hard-coded built-in list                                                                                            | Lazy `models.dev/api.json` with disk cache                                                                                                                                                            |
| Default chat model                                      | `defaultModelKey` field                                                                                             | **Removed** (kept temporarily as input to the Quick Chat agent's seeding; see follow-up doc)                                                                                                          |
| Per-model overrides (temp, max_tokens, capabilities, …) | Per-`CustomModel` fields                                                                                            | **Removed** — all chains use global defaults; capabilities are not stored on registry entries (consulted from the catalog at the point of use)                                                        |
| Per-provider "Availability" toggles (chat/agent/mobile) | Implicit in code                                                                                                    | **Removed** — registered = available; per-agent picker curation handles "show in X"                                                                                                                   |
| Per-model "Hide from picker" checkbox in BYOK table     | `enabled: false` on `CustomModel`                                                                                   | **Removed** — to hide a model, uncheck it inside Configure Provider (this removes it from the registry; per-agent curation lives in Agent tab)                                                        |
| Settings versioning                                     | Heuristic (presence/type checks)                                                                                    | Explicit `settingsVersion: number` with a registered migration chain                                                                                                                                  |
| Embedding model management                              | Inside "Models" tab alongside chat models                                                                           | Bottom section of the **renamed "Embedding" tab** (was "QA"); other QA settings stay in place.                                                                                                        |
| LangChain chat                                          | Implicit "chain mode" coupled to chat input                                                                         | **Becomes the "Quick Chat" agent backend** — see `designdocs/QUICK_CHAT_AGENT_INTEGRATION.md` (follow-up doc; out of scope for this plan)                                                             |

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
- ❌ Chat session start — chat reads `ProviderRegistry` + `ModelRegistry` (which don't need the catalog at all; catalog only powers the BYOK _picker_).
- ❌ Agent session start — same reason.

**Fetch behavior:**

- 5s timeout. On timeout or non-200, log a `logWarn` and keep serving the existing memory/disk source.
- The catalog service emits change events so the BYOK tab + Configure Provider dialog re-render when fresh data arrives.

**Why lazy:**

- Most plugin sessions never touch the BYOK tab (users configure once, then chat); fetching on boot wastes a network round-trip every launch.
- The catalog is metadata for the _picker_ — registered models live in `settings.registry` and are usable without ever calling `ModelCatalogService`. The runtime chat/agent paths don't need it.

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

**Excluded** from the earlier draft: `togetherai`, `fireworks-ai`, `perplexity` — no first-class LangChain adapter in this plugin. Users who want them can still add them as a custom provider using the `openai-compatible` path.

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

> **Registry entries do not store capabilities.** The `capabilities` field has been removed from `RegistryEntry`. The catalog's per-model capability fields (`reasoning`, `tool_call`, `modalities.input`) remain on `CatalogModel` for any consumer that needs to consult them at the moment of use, but they are no longer materialized into the registry. See the follow-up section "Future migration: CustomModel capability removal" for the legacy `CustomModel.capabilities` consumers still reading the v0-side enum.

### 1.4 Catalog service

Create `src/modelManagement/catalog/ModelCatalogService.ts` — a thin lazy read-only facade with the two-tier read path:

```typescript
class ModelCatalogService {
  // Idempotent. First call triggers disk read; subsequent calls are no-ops.
  // Returns immediately after memory cache is populated (empty if no disk cache yet).
  ensureLoaded(): Promise<void>;

  // All reads are synchronous after ensureLoaded() resolves.
  getProvider(id: ProviderId): CatalogProvider | undefined;
  getModel(providerId: ProviderId, modelId: string): CatalogModel | undefined;
  getAllProviders(): CatalogProvider[]; // sorted: recommended first (Anthropic / OpenAI / Google)
  searchModels(providerId: ProviderId, query: string, filters: CatalogFilters): CatalogModel[];

  // Live data integration
  refresh(): Promise<RefreshResult>; // user-triggered or auto-triggered (BYOK tab open + 24h stale)
  getMeta(): { fetchedAt: number | null; source: "live" | "disk" | "bundled" };
  onChange(listener: () => void): () => void; // emits when memory cache updates
}

interface CatalogFilters {
  contextAtLeast?: number; // ≥ 200k ctx chip
  maxCostPerMillion?: number; // ≤ $1/M chip
  releasedWithinMonths?: number; // Released ≤ 6mo chip
}
```

**No `capability` filter in `searchModels`.** Capability filters (Vision / Reasoning / Tool use) are removed from the UI per the latest design. Catalog code can still inspect `tool_call` / `reasoning` / `modalities.input` for internal routing decisions (the Quick Chat agent will need to know whether a model supports tool calls, for example).

**No OpenCode source augmentation.** The previous draft routed OpenCode-enumerated models through this service. That's gone — `ModelCatalogService` is for the **BYOK picker only**, and BYOK never shows OpenCode-bundled or Copilot-Plus models. The OpenCode sub-tab in the Agent panel queries OpenCode directly for its bundled list (Big Pickle, etc.) and Copilot-Plus for its hosted list; those are merged with BYOK agent-capable registry entries to populate the OpenCode picker at render time. See §5.4.1 and M8 below.

---

## 2. New data model

### 2.1 Top-level `CopilotSettings` additions

```typescript
interface CopilotSettings {
  // … existing unrelated fields …

  /** Monotonic settings schema version. Migrations run on load when this is < current. */
  settingsVersion: number; // current = 2 after this redesign

  /** Provider credentials & display config, keyed by provider id. */
  providers: Record<ProviderId, ProviderConfig>;

  /** User's enabled models — the BYOK registry. */
  registry: RegistryEntry[];

  // existing fields like agentMode, activeEmbeddingModels (untouched) remain
}

type ProviderId = string;
// Built-in providers use canonical models.dev ids: "anthropic", "openai", etc.
// Custom providers use uuid-prefixed ids: "custom:550e8400-e29b-41d4-a716-446655440000"
// System-managed: "opencode" and "copilot-plus" — never appear in `providers` map.

interface ProviderConfig {
  id: ProviderId;
  kind: "builtin" | "custom"; // determines `type` editability
  displayName: string; // "Anthropic" or user-given "Ollama (local)"
  type: "openai-compatible" | "anthropic" | "google" | "azure" | "bedrock" | "github-copilot";
  baseUrl?: string; // optional override; for `custom` always present
  apiKeyRef?: KeychainRef | null; // null = no key required (some local servers)
  // Opaque provider-specific payload. Validated by the provider class's Zod schema
  // (see §3.6) — keeps `ProviderConfig` flexible without ballooning the union type.
  extra?: Record<string, unknown>;
  addedAt: number;
  lastVerifiedAt?: number;
  lastVerificationError?: string;
}

interface RegistryEntry {
  providerId: ProviderId; // "anthropic" | "custom:…" — never "opencode" / "copilot-plus"
  modelId: string; // "claude-sonnet-4-5-20250929"
  displayName: string; // "Claude Sonnet 4.5"
  addedAt: number;
  lastVerifiedAt?: number;
  lastVerificationError?: string;
}
```

**Capabilities are not stored on the registry.** Per-model capability tags (`reasoning`, `tool_call`, vision via `modalities.input`, context window, release date) live on `CatalogModel` and are consulted at the point of use — they're not materialized into a registry-side enum. See the follow-up section "Future migration: CustomModel capability removal" for the legacy CustomModel-based code paths that still carry their own pre-v2 `ModelCapability` enum.

**Notable removals from earlier draft:**

- `ProviderConfig.availability` (chat/opencode/mobile checkboxes) — removed entirely. Once a provider is registered, its models are available to whatever agent backend can use them. Per-agent curation moved to Agent tab.
- `RegistryEntry.visible` (per-model checkbox in BYOK table) — removed. Registered = visible. To hide a model: uncheck it inside Configure Provider's model picker and save (which removes it from the registry).
- `RegistryEntry.origin` — removed. Every registry entry is a BYOK entry. OpenCode-bundled and Copilot-Plus models **never become registry entries** (see §5.4.1 for how the OpenCode picker assembles its model list at render time instead).
- `ProviderConfig.extra` is now an opaque `Record<string, unknown>` (was a typed union). Provider classes own the shape via their own Zod schemas (§3.6) — keeps the core type stable while letting providers evolve their own payloads.

### 2.2 Per-agent model picker curation

Each agent backend (including the new Quick Chat backend defined in the follow-up doc) maintains its own `modelEnabledOverrides`. The map is **scoped per backend by its storage path** (`agentMode.backends.<id>.modelEnabledOverrides`), so the key inside the map never repeats the backend id:

```typescript
interface AgentBackendCommonSettings {
  defaultModel?: ModelSelection | null; // { baseModelId, effort }
  // Which registry models surface in this backend's in-session model picker.
  // Missing entry = default to true (visible). Explicit false = hidden.
  modelEnabledOverrides?: Record<string, boolean>;
}
```

Applied to all backends: `agentMode.backends.opencode`, `agentMode.backends.claude`, `agentMode.backends.codex`, **and** the new `agentMode.backends.quickChat` (declared here as a structural placeholder; full integration is in the follow-up doc).

**Source of truth for each backend's picker:**

- **OpenCode picker** — assembles its model list at render time from **three sources, unioned**:
  1. OpenCode's own enumeration of bundled models (Big Pickle, etc.) — queried directly from the running OpenCode binary.
  2. Copilot-Plus hosted models (Plus Flash, etc.) — queried from the Plus license endpoint when active.
  3. BYOK registry entries — `ModelRegistry.list()`.
     Then filtered via `agentMode.backends.opencode.modelEnabledOverrides`. None of these enter the BYOK table; they're a per-backend picker concern.
- **Claude Code / Codex pickers** — read each backend's _bundled_ model list (still hard-coded per backend; these are subscription-bound and don't reference the BYOK registry), filtered via `modelEnabledOverrides`.
- **Quick Chat picker (follow-up doc)** — reads `ModelRegistry.list()`, filtered via `agentMode.backends.quickChat.modelEnabledOverrides`.

**Model-key format inside `modelEnabledOverrides`** depends on what uniquely identifies a model within a single backend's catalog:

- **OpenCode**: bare wire-form `baseModelId` (`anthropic/claude-sonnet-4-5`, `bigpickle/big-pickle`, `copilot-plus/copilot-plus-flash`, `custom:abc-uuid/llama-3.3`). The provider segment is already part of the wire form, so the same `modelId` from two providers (e.g. Anthropic vs OpenRouter) maps to two distinct keys — no collision.
- **Claude Code / Codex**: bare `baseModelId` (`claude-sonnet-4-5`, `gpt-5`). Single-provider backends; `modelId` alone is unique.
- **Quick Chat**: `<providerId>:<modelId>` (e.g. `anthropic:claude-opus-4-7`). Quick Chat routes through multiple BYOK providers within one backend slice, so the bare `modelId` would collide; pairing with `providerId` disambiguates.

The runtime picker (`isAgentModelEnabled` in `src/agentMode/session/modelEnable.ts`) and every settings panel MUST agree on the same key shape per backend — divergence here was the bug behind the M9 follow-up that introduced this section. These keys exist only inside `modelEnabledOverrides` — never in the `registry` array.

### 2.3 Removed from `CopilotSettings` (legacy → migrated)

| Removed field                                                                                                                                                                                                                                                                                      | Migrated to                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openAIApiKey`, `openAIOrgId`, `azureOpenAI*`, `anthropicApiKey`, `googleApiKey`, `cohereApiKey`, `mistralApiKey`, `deepseekApiKey`, `groqApiKey`, `xaiApiKey`, `openRouterAiApiKey`, `siliconflowApiKey`, `amazonBedrockApiKey`, `amazonBedrockRegion`, `huggingfaceApiKey`, `openAIProxyBaseUrl` | `providers[<id>].apiKeyRef` + `providers[<id>].baseUrl` + `providers[<id>].extra`                                                                        |
| `activeModels: CustomModel[]` (chat half)                                                                                                                                                                                                                                                          | `registry: RegistryEntry[]`                                                                                                                              |
| `defaultModelKey`                                                                                                                                                                                                                                                                                  | **Re-seeded as** `agentMode.backends.quickChat.defaultModel` (so the user's last-chosen chat model is what Quick Chat boots with). Field itself deleted. |
| Per-`CustomModel` overrides: `temperature`, `maxTokens`, `topP`, `frequencyPenalty`, `numCtx`, `reasoningEffort`, `verbosity`, `stream`, `streamUsage`, `useResponsesApi`, `enablePromptCaching`, `enableCors`, `capabilities` (user-set)                                                          | **Dropped** — surfaced via one-time toast (§4.4)                                                                                                         |
| `agentMode.enabled`                                                                                                                                                                                                                                                                                | Removed — desktop is always agent-capable                                                                                                                |

**Kept unchanged:**

- `activeEmbeddingModels` (moved to a new "Embeddings" tab UI-wise in M3, but the data field is untouched)
- `agentMode.backends.opencode`, `agentMode.backends.claude`, `agentMode.backends.codex` (existing `modelEnabledOverrides` are now keyed by the bare wire-form `baseModelId` after migration; see §2.2)
- `agentMode.byok` (kept; OpenCode reads it for agent-mode credentials)
- `temperature`, `maxTokens`, `reasoningEffort`, `verbosity` (kept as **global** defaults, no longer per-model)
- GitHub Copilot OAuth fields (`githubCopilotAccessToken` etc.) — these are OAuth tokens not user-entered keys; they live alongside `providers["github-copilot"]` but aren't migrated into `apiKeyRef`

### 2.4 Settings version field

Add `settingsVersion: number` to `CopilotSettings` with a default of `0` for unmigrated settings.

- `0` = original (any settings written before this redesign ships)
- `2` = post-migration

**Migration runner** (`src/settings/migrations/runMigrations.ts`):

```typescript
type Migration = (raw: any) => any;
const MIGRATIONS: Record<number, Migration> = {
  2: migrateV0toV2,
};
function runMigrations(raw: any): { settings: any; migrationsApplied: number[] };
```

`runMigrations` is called once inside `sanitizeSettings` before any other normalization, on every settings load. Idempotent (no-op when `settingsVersion === current`).

**How we know a user has migrated:** `settings.settingsVersion >= 2`. We also write a sticky breadcrumb `settings._migrationBreadcrumbs: Array<{ from: number; to: number; appliedAt: number; droppedFields?: string[] }>` for forensics (also surfaces the toast content in M2).

### 2.5 API key storage

The existing `KeychainService` (`src/services/keychainService.ts`) already supports per-field keychain storage with a vault-scoped ID scheme. Extend it with a new namespace:

```
copilot-v{8hex-vault-id}-provider-{providerId}-apiKey
copilot-v{8hex-vault-id}-provider-{providerId}-extra-{name}
```

`ProviderConfig.apiKeyRef` is `{ kind: "keychain"; id: string }` or `{ kind: "inline"; value: string }` depending on whether keychain is available (the `_keychainOnly` setting governs this — preserved from current behavior). Migration moves keys from the existing top-level keychain entries (`copilot-v{id}-openai-api-key`) to the new namespace.

---

## 3. Code architecture — separation of concerns

### 3.0 One module, one boundary: `src/modelManagement/`

All provider, model, catalog, and BYOK-UI code lives in a single top-level module under `src/modelManagement/`. The module has **one public entry point** — `src/modelManagement/index.ts` — and an **eslint-enforced import boundary** prevents the rest of the codebase from reaching past it into internals.

**Public API surface** (everything else is private to the module):

```typescript
// src/modelManagement/index.ts — the ONLY file outside callers may import from
export { ProviderRegistry } from "./providers/ProviderRegistry";
export { ModelRegistry } from "./registry/ModelRegistry";
export { ModelCatalogService } from "./catalog/ModelCatalogService";
export { ChatModelManager } from "./chatModel/ChatModelManager";
export type {
  ProviderId,
  ProviderConfig,
  RegistryEntry,
  ModelCapability,
  KeychainRef,
  VerificationResult,
} from "./types";
export { ByokPanel } from "./ui/tabs/ByokPanel";
export { runModelManagementMigrations } from "./migrations/runMigrations";
export { SUPPORTED_PROVIDER_IDS } from "./providers/supportedProviders";
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
      "not from internal files. See designdocs/MODEL_MANAGEMENT_IMPLEMENTATION.md §3.0.",
  }],
}]
```

**Why a single module:** Today provider knowledge is scattered across `src/LLMProviders/`, `src/settings/v2/components/ModelSettings.tsx`, `src/constants.ts` (BUILTIN_CHAT_MODELS), and ~25 top-level settings fields. Pulling all of that into one boundary makes the responsibility explicit: model management owns providers + models + catalog + the BYOK UI. Consumers (agent backends, chat input, embeddings) talk to it through a small surface and never reach inside.

**What stays outside the module:**

- Agent backend internals (`src/agentMode/backends/*`) — they consume `ModelRegistry` + `ProviderRegistry` via the public API.
- Chat view + chat input — same.
- Embeddings management — keeps its own surface in `src/embedding/` (separate workstream).
- Settings shell / non-model tabs (`Chat`, `Commands`, etc.) — they just register `ByokPanel` as a tab component.

### 3.1 `src/modelManagement/providers/ProviderRegistry.ts` (NEW)

Source of truth for provider credentials and metadata. Wraps `settings.providers` + keychain.

```typescript
class ProviderRegistry {
  list(): ProviderConfig[];
  get(id: ProviderId): ProviderConfig | undefined;
  add(config: Omit<ProviderConfig, "addedAt">): Promise<void>;
  update(id: ProviderId, patch: Partial<ProviderConfig>): Promise<void>;
  remove(id: ProviderId): Promise<void>; // removes provider + all its registry entries
  getApiKey(id: ProviderId): Promise<string | null>;
  verify(id: ProviderId): Promise<VerificationResult>;
}
```

### 3.2 `src/modelManagement/registry/ModelRegistry.ts` (NEW)

Source of truth for enabled models (BYOK registry). Wraps `settings.registry`.

```typescript
class ModelRegistry {
  list(filter?: { providerId?: ProviderId; capability?: ModelCapability }): RegistryEntry[];
  get(providerId: ProviderId, modelId: string): RegistryEntry | undefined;
  add(entry: Omit<RegistryEntry, "addedAt">): Promise<void>;
  remove(providerId: ProviderId, modelId: string): Promise<void>;
  // Used by chat input model picker — delegates to the active agent backend's picker
  // (resolution logic lives in the follow-up doc).
  // Used by Agent tab's per-backend picker section
  listForAgentPicker(backendId: BackendId): RegistryEntry[];
  // Bulk operations for Configure Provider modal save
  bulkSet(providerId: ProviderId, entries: RegistryEntry[]): Promise<void>;
}
```

Notable: `updateVisibility` is **removed** from the earlier draft. Visibility is no longer a per-registry-entry property — it's a per-agent-backend curation handled by each backend's `modelEnabledOverrides`.

### 3.3 `src/modelManagement/catalog/ModelCatalogService.ts` (NEW)

Already covered in §1.4. Lazy, read-only facade with two-tier fallback.

### 3.4 `ChatModelManager` refactor

Current: reads ~15 different fields off `CopilotSettings` to build LangChain clients.

After: reads `ProviderRegistry.get(...)` + `ModelRegistry.get(...)` to assemble a `ChatModelConfig`. Per-model overrides removed; global `temperature` / `maxTokens` / `reasoningEffort` still honored.

A pure helper `buildLangChainConfig(provider: ProviderConfig, entry: RegistryEntry, defaults: ChatDefaults): ChatModelConfig` lives in its own file (no LangChain imports — unit-testable per `AGENTS.md` testing guidance).

**Out of scope here:** The integration between `ChatModelManager` and the new Quick Chat agent backend (so the chat input → Quick Chat → LangChain wiring works end-to-end) — see `designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`.

### 3.5 Folder layout (everything model-related lives here)

```
src/
├─ modelManagement/                              ← THE MODULE (one boundary)
│  ├─ index.ts                                   ← public API surface (§3.0)
│  ├─ types.ts                                   ← ProviderConfig, RegistryEntry, …
│  ├─ catalog/
│  │  ├─ ModelCatalogService.ts                  ← lazy + 3-tier read
│  │  └─ modelsCatalog.types.ts
│  ├─ providers/
│  │  ├─ ProviderRegistry.ts
│  │  ├─ supportedProviders.ts                   ← SUPPORTED_PROVIDER_IDS (single source)
│  │  └─ adapters/                               ← was src/LLMProviders/ — relocated
│  │     ├─ AnthropicAdapter.ts                  (each adapter exports langchain factory
│  │     ├─ OpenAIAdapter.ts                      + extraSchema: z.ZodSchema)
│  │     ├─ GoogleAdapter.ts
│  │     ├─ AzureAdapter.ts                      ← uses extraSchema for instance/deployment/version
│  │     ├─ BedrockAdapter.ts                    ← uses extraSchema for region
│  │     ├─ ...
│  │     └─ index.ts                             ← adapter registry keyed by ProviderId
│  ├─ registry/
│  │  └─ ModelRegistry.ts
│  ├─ chatModel/
│  │  ├─ ChatModelManager.ts                     ← refactored to read Provider+Model registries
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
│  ├─ v2/                                        ← legacy; selected files retired in M9
│  │  └─ components/
│  │     ├─ QASettings.tsx                       (renamed "Embedding" tab, extended in M3)
│  │     └─ EmbeddingModelsSection.tsx           (extracted in M3 — used by QASettings)
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

### 3.6 Provider adapters own their `extra` shape

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
  provider: ProviderConfig,
  entry: RegistryEntry,
  defaults: ChatDefaults,
): BaseChatModel {
  const extra = extraSchema.parse(provider.extra);   // throws → caught + surfaced as verification error
  return new AzureChatOpenAI({ ... extra ... });
}
```

`extraSchema` defaults to `z.object({}).strict()` for adapters with no extras. The Configure Provider dialog uses the schema (via a `getExtraFormFields(adapter)` helper) to render the right inputs in the "advanced" section — adding a new provider's extra field is a one-line schema change, no UI rewrite required.

This keeps `ProviderConfig.extra: Record<string, unknown>` opaque at the core-type level while letting each provider declare exactly what it needs.

---

## 4. Migration strategy (v0 → v2)

### 4.1 Where it runs

Inside `sanitizeSettings(raw)` in `src/settings/model.ts`, immediately after parsing data.json and **before** field normalization. Single entry point; runs on every load; idempotent when `settingsVersion >= 2`.

### 4.2 Migration steps (v0 → v2)

Implemented in `src/settings/migrations/v0-to-v2.ts`. Order matters:

1. **Initialize new shape** — `settings.providers = {}`, `settings.registry = []`, `settings._migrationBreadcrumbs = settings._migrationBreadcrumbs ?? []`.

2. **Provider keys → `providers` map.** For each non-empty legacy field, synthesize a `ProviderConfig`:

   | Legacy field(s)                                        | Synthesized provider                                                  |
   | ------------------------------------------------------ | --------------------------------------------------------------------- |
   | `openAIApiKey` (+ `openAIOrgId`, `openAIProxyBaseUrl`) | `providers["openai"]`                                                 |
   | `anthropicApiKey`                                      | `providers["anthropic"]`                                              |
   | `googleApiKey`                                         | `providers["google"]`                                                 |
   | `cohereApiKey`                                         | `providers["cohere"]`                                                 |
   | `mistralApiKey`                                        | `providers["mistral"]`                                                |
   | `deepseekApiKey`                                       | `providers["deepseek"]`                                               |
   | `groqApiKey`                                           | `providers["groq"]`                                                   |
   | `xaiApiKey`                                            | `providers["xai"]`                                                    |
   | `openRouterAiApiKey`                                   | `providers["openrouter"]`                                             |
   | `siliconflowApiKey`                                    | `providers["siliconflow"]`                                            |
   | `amazonBedrockApiKey` (+ `amazonBedrockRegion`)        | `providers["amazon-bedrock"]` (with `extra.bedrockRegion`)            |
   | `azureOpenAIApiKey` (+ instance/deployment/version)    | `providers["azure"]` (with `extra.azure*`)                            |
   | `huggingfaceApiKey`                                    | **Dropped** (not in design's provider allowlist — log to breadcrumbs) |

   Each synthesized provider gets `kind: "builtin"`, `addedAt: Date.now()`. No `availability` field (removed from the data model).

3. **Custom-provider `CustomModel` entries → `providers["custom:<uuid>"]`.** Group `activeModels` entries by unique `{baseUrl, apiKey}` tuple (when `provider` is `OPENAI_FORMAT`, `OLLAMA`, `LM_STUDIO`, or any `isBuiltIn: false` entry with a `baseUrl`). Each group becomes one custom `ProviderConfig`:

   ```
   id:          "custom:<uuid>"
   kind:        "custom"
   displayName: <baseUrl-derived label, e.g. "Local (localhost:11434)" or first model's provider field>
   type:        provider type inferred from `provider` field (default: "openai-compatible")
   baseUrl:     <baseUrl>
   apiKeyRef:   <migrated to keychain or kept inline>
   ```

4. **`activeModels` (chat half) → `registry`.** For each entry, decide first whether to drop or migrate:
   - **Drop** (do not create a registry entry; log to breadcrumbs) if **any** of these are true:
     - `entry.isEmbeddingModel === true` — handled by `activeEmbeddingModels`, unchanged.
     - `entry.enabled === false` — the new model has no per-model visibility flag; treat as deleted.
     - `entry.isBuiltIn === true` **and** the provider step (2 or 3) did NOT produce a `ProviderConfig` for that provider (i.e., the user never set up an API key for the provider that ships this built-in model). The user was never actually using it — it was just visual clutter from the legacy `BUILTIN_CHAT_MODELS` list.
     - `entry.provider` is OpenCode-bundled or Copilot Plus — those no longer live in the registry. Their selections are forwarded into `agentMode.backends.opencode.modelEnabledOverrides` keyed by the bare wire-form `baseModelId` (e.g. `bigpickle/big-pickle`, `copilot-plus/copilot-plus-flash`) so the OpenCode picker keeps showing them.

   - Otherwise **migrate** to a `RegistryEntry`:
     ```
     providerId:    canonical-id-for-entry.provider OR the custom-provider id from step 3
     modelId:       entry.name
     displayName:   entry.displayName ?? entry.name
     addedAt:       Date.now()
     ```

   Migration does not read the catalog. Capability tags, context window, and release date are not stored on the registry — catalog data is consulted at the point of use instead. See the follow-up section "Future migration: CustomModel capability removal" for the legacy capability consumers still living on `CustomModel`.

   Net effect for built-in handling: a user who never configured any keys ends up with `providers = {}` and `registry = []` — nothing to migrate, nothing surfaced. A user who configured the OpenAI key keeps only the OpenAI models they were actually using (built-in entries for OpenAI migrate in; built-in entries for other providers without keys are dropped). The toast in §4.4 reports the dropped count.

5. **`activeModels` per-model overrides → dropped, logged to breadcrumbs.** For each entry that had any of `temperature`, `maxTokens`, `topP`, `frequencyPenalty`, `numCtx`, `reasoningEffort`, `verbosity`, `stream`, `streamUsage`, `useResponsesApi`, `enablePromptCaching`, `enableCors`, `capabilities`, push to `_migrationBreadcrumbs[*].droppedFields`. The toast in §4.4 reads from this.

6. **Agent overrides re-keyed.** Existing `agentMode.backends.<backend>.modelEnabledOverrides` uses model-name keys (or panel-prefixed `<providerOrSource>:<modelId>` keys from an earlier draft of M9). Normalize per §2.2:
   - **opencode**: bare wire-form `baseModelId`. Legacy `<modelName>|<provider>` becomes `<providerId>/<modelName>` (resolved against the providers map; orphans dropped to breadcrumbs); panel-prefixed `opencode:<rest>` keeps `<rest>` (already wire form); `copilot-plus:<modelId>` becomes `copilot-plus/<modelId>`; `<byokProviderId>:<modelId>` (longest-prefix match against the providers map) becomes `<byokProviderId>/<modelId>`.
   - **claude / codex**: bare model name. Legacy `<modelName>|<provider>` keeps `<modelName>`; panel-prefixed `<backendId>:<rest>` keeps `<rest>`.
   - **quickChat**: keep `<providerId>:<modelId>` form.
     If a key cannot be resolved to a registered model (e.g. the model was disabled in step 4), drop the override (logged to breadcrumbs). Overrides are **kept** for all four backends — none are folded into a registry-level flag.

7. **`defaultModelKey` → Quick Chat default.** Resolve `defaultModelKey` (`<name>|<provider>` format) to a `RegistryEntry`. Seed `agentMode.backends.quickChat = { defaultModel: { baseModelId: "<providerId>:<modelId>", effort: null }, modelEnabledOverrides: {} }`. If no match, leave Quick Chat without a default. Then delete `defaultModelKey`.

   _(The Quick Chat backend infrastructure itself is in the follow-up doc; this migration step only ensures the data is in place so the follow-up implementation has something to read.)_

8. **`agentMode.enabled` → dropped.** Desktop is always agent-capable.

9. **API keys → keychain.** If keychain is available (`_keychainOnly` is true), each migrated provider's `apiKeyRef` is moved into the new `provider-<id>-apiKey` keychain entry and the legacy entry (`<id>-api-key`) is deleted. If keychain unavailable, `apiKeyRef = { kind: "inline", value: <key> }`.

10. **Delete legacy top-level fields** — remove all the legacy provider key fields (see §2.3 table) from the settings object so they're gone from `data.json` after first save.

11. **Stamp version** — `settings.settingsVersion = 2`; append breadcrumb `{ from: 0, to: 2, appliedAt: Date.now(), droppedFields: [...all dropped per-model override field-paths] }`.

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
• Default chat model now lives under Agent → Quick Chat.
• Provider keys moved to the new BYOK tab.
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

| Tab (settings modal)                                                                                                     | Implementation                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **BYOK** (NEW; central registry — providers + models)                                                                    | `src/modelManagement/ui/tabs/ByokPanel.tsx` |
| **Agent** (REPLACED; OpenCode / Claude Code / Codex / Quick Chat sub-tabs)                                               | `src/settings/v3/tabs/AgentPanel.tsx`       |
| **Embedding** (RENAMED from "QA"; existing QA settings stay where they are, embedding model section added at the bottom) | existing QA tab file, extended in-place     |
| Chat (renamed from "Basic"; cosmetic only — content unchanged)                                                           | existing v2 component, header label tweak   |
| Commands (renamed from "Chat & Commands"; cosmetic only)                                                                 | existing v2 component, header label tweak   |
| Advanced, etc. (UNCHANGED)                                                                                               | existing v2 components, no rewrite          |

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

- Picker section sources from `ModelRegistry.list()`.
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
  - `src/modelManagement/types.ts` with `ProviderConfig`, `RegistryEntry`, `ProviderId`, etc.
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
   - Open Settings → existing legacy tabs work normally; plugin onload **does not** trigger any models.dev request (verify via dev-tools network panel).
   - `ModelCatalogService.getInstance().getMeta()` returns `{ fetchedAt: null, source: "bundled" }` until something invokes `ensureLoaded()`. (The `source` string still reads `"bundled"` as a legacy sentinel; semantically it means "no live data yet.")
   - Calling `ensureLoaded()` (e.g. via a temporary dev command) reads disk cache or leaves memory empty; calling `refresh()` triggers a live fetch and updates disk + memory.

**Out of scope:** No UI consumes the catalog yet beyond a dev-mode smoke logger; lazy hook into BYOK tab open is wired in M4.

---

### M2 — Schema, migration, and service skeleton

**Goal:** Introduce `settingsVersion`, `providers`, `registry`; write v0→v2 migration; refactor `ChatModelManager` to read the new shape. After this milestone, the plugin behaves identically to before from the user's perspective — only the internal data layout has changed.

**Deliverables:**

- `src/settings/model.ts` — slimmed to schema only. Re-exports `ProviderConfig` / `RegistryEntry` / `ProviderId` etc. from `@/modelManagement` rather than redefining. Add `settingsVersion`, `providers`, `registry`, `_migrationBreadcrumbs`, `_migrationNoticeDismissed` fields. Remove the legacy provider-key fields, `defaultModelKey`, and `agentMode.enabled` from the interface. Add `agentMode.backends.quickChat` skeleton type (per §2.2).
- `src/modelManagement/migrations/runMigrations.ts` + `v0-to-v2.ts` — runner + v0→v2 implementation. **Migration must run synchronously** — it cannot await the catalog service. It does not read the catalog at all; registry entries are built from v0 data alone (no capability inference, no contextWindow/releaseDate enrichment).
- `src/modelManagement/providers/ProviderRegistry.ts` and `src/modelManagement/registry/ModelRegistry.ts` — full implementations.
- `src/modelManagement/providers/adapters/` — relocate `src/LLMProviders/*` here. Each adapter file exports `buildLangChainClient(...)` + `extraSchema: z.ZodSchema` per §3.6. `index.ts` exposes the adapter registry.
- `src/modelManagement/chatModel/ChatModelManager.ts` — refactored to read from `ProviderRegistry` + `ModelRegistry` only; consults the adapter registry for instantiation.
- `src/modelManagement/chatModel/buildLangChainConfig.ts` — extracted pure helper + unit tests.
- Migration notice toast (§4.4) wired in `main.ts` `onload` after settings load.
- Dev command `Copilot: Show settings migration status` registered.
- `src/modelManagement/migrations/__tests__/v0-to-v2.test.ts` — fixture-based tests:
  - Fresh install (empty settings) → `settingsVersion = 2`, `providers = {}`, `registry = []`, `agentMode.backends.quickChat = { defaultModel: null, modelEnabledOverrides: {} }`.
  - Settings with only OpenAI key (no `activeModels`) → one provider, no registry entries.
  - Settings with `activeModels` containing only built-in entries and **no** provider keys → `providers = {}`, `registry = []` (every built-in dropped because no key existed).
  - Settings with OpenAI key configured + built-in entries from Anthropic, Google, OpenAI → only the OpenAI built-ins migrate; Anthropic + Google built-ins dropped (no keys); breadcrumb lists the dropped models.
  - Settings with `activeModels` mix of built-in + custom + Ollama → providers + registry entries split correctly; embedding models stay in `activeEmbeddingModels`.
  - Settings with per-model overrides → overrides dropped, breadcrumbs populated.
  - Settings with `activeModels[*].enabled = false` → entry dropped, breadcrumb logged.
  - Settings with `agentMode.backends.<id>.modelEnabledOverrides` keyed by old `<modelName>|<provider>` → normalized per §2.2 (opencode → wire form `<providerId>/<modelName>`; claude/codex → bare `<modelName>`; quickChat → `<providerId>:<modelName>`); orphans dropped.
  - Settings with `defaultModelKey = "claude-sonnet-4-5|anthropic"` → `agentMode.backends.quickChat.defaultModel.baseModelId = "anthropic:claude-sonnet-4-5"`.
  - Settings with no fields at all (corrupt) → migration falls back gracefully.
  - Idempotency: running migration twice produces the same output.
  - OpenCode-bundled / Plus models in `activeModels`: skipped from `registry`; forwarded into `agentMode.backends.opencode.modelEnabledOverrides` with bare wire-form `baseModelId` keys (bundled stays as-is; Plus prepends `copilot-plus/`) per migration step 4.

**Agent verification checklist:**

1. `npm run test -- migrations` — fixtures green.
2. Run `npm run build` then load plugin in test vault with a pre-existing `data.json` from `git stash` (or seed one); verify:
   - Notice toast appears once.
   - Opening Settings → existing Basic + Models tabs still render (UI hasn't migrated yet) and show the migrated data correctly.
   - Chat works — pick a model in chat input, send a message, get a response.
   - Restart plugin → toast does NOT reappear.
3. Run `Copilot: Show settings migration status` command → modal shows breadcrumb with `from: 0, to: 2`.
4. Garbage `data.json` → safety net catches it; toast says "Couldn't upgrade", plugin still works in degraded mode.
5. Manual screenshot before/after — settings model picker still shows correct selection.

**Risk:** Any consumer outside `ChatModelManager` that reads `settings.openAIApiKey` etc. directly will break. **Pre-flight grep** (see Appendix A) and update each call site to read from `ProviderRegistry`.

---

### M3 — Move embedding models into the QA tab (and rename to "Embedding")

**Goal:** Pull the embedding model section out of the old `ModelSettings.tsx` and drop it into the existing QA tab at the bottom. Rename the tab from "QA" to "Embedding". All other QA settings stay exactly where they are.

**Deliverables:**

- `src/settings/v2/components/QASettings.tsx` (the existing QA tab file) — extended:
  - Existing QA settings (semantic-search settings, indexing settings, exclusions, etc.) stay in place at the top.
  - **New section at the bottom**: heading "Embedding models" + the embedding-model table moved verbatim from `ModelSettings.tsx`. Same add/edit/delete flows, same `activeEmbeddingModels` field, same existing dialog components. Code is _moved_ (not copied) — the embedding table component lives in its own file extracted from `ModelSettings.tsx`.
  - Tab label updated to **"Embedding"**.
- `src/settings/v2/components/ModelSettings.tsx` — embedding portion removed; only chat table remains (chat table itself goes away in M4–M9 as BYOK takes over).
- `src/settings/v2/SettingsMainV2.tsx` — tab label changed from "QA" to "Embedding"; tab order unchanged.
- Extracted embedding table component (e.g. `src/settings/v2/components/EmbeddingModelsSection.tsx`) so M3 is mostly a move-rename refactor with no behavior change.
- Snapshot tests for the renamed tab.

**Agent verification checklist:**

1. Open settings → tab strip shows "Embedding" where "QA" was. Same position in the strip.
2. Open Embedding tab → existing QA settings visible at the top (semantic search, indexing, exclusions, etc.); embedding models table at the bottom.
3. Embedding model add / edit / delete / toggle flows all work; vector store rebuild still works (trigger via existing command).
4. Old "Models" tab → only chat models visible; embedding table gone.
5. No other settings tabs moved or renamed.

---

### M4 — BYOK panel (global table + provider sections, no dialogs yet)

**Goal:** Implement the new BYOK tab as one global table with provider section rows. Existing add/edit flows still go through the old `ModelAddDialog` for this milestone (we wire the new dialogs in M5). The BYOK tab and old Models tab **both** exist after this milestone — but BYOK becomes the new primary.

**Deliverables:**

- `src/modelManagement/ui/tabs/ByokPanel.tsx`:
  - **On mount**: `await ModelCatalogService.getInstance().ensureLoaded()` (skeleton during load); then if `getMeta().fetchedAt < Date.now() - 24h`, fire-and-forget `refresh()`.
  - Empty state with `[+ Add provider]` (button opens a placeholder modal until M5).
  - Populated state with one global table per §5.1.
  - Header: title + the user-bring description copy per §5.1 + `[↻ Refresh catalog]` (with last-fetched timestamp tooltip) + `[Manage providers]` + `[+ Add provider]`.
  - Filter bar: search input + `All` / `local` / `≥ 200k ctx` chips (no capability chips).
  - Footer: `<N> enabled across <M> providers · <K> available in catalog`.
- `src/modelManagement/ui/components/ByokGlobalTable.tsx` — one global table component handling provider section rows + indented model rows:
  - Provider section row: chevron · glyph · name · count · badge (`custom endpoint` if `kind === "custom"`) · `[⚙ Configure]` (ghost) · `⋯` (kebab → single "Remove provider" item).
  - Model rows: `Model name` + `Meta` only. No checkbox. No kebab. No badges.
  - Foldable per provider (default: open; remembers state per provider).
- `src/settings/v2/SettingsMainV2.tsx` — register "BYOK" tab; rename old "Models" tab to "Models (legacy)" with a strikethrough style — to be removed in M9.
- Mobile rendering: `useIsMobile()` hook adapts header copy and stacks controls; provider sections look the same (since OpenCode/Plus rows are gone anyway).
- Tests: snapshot for populated/empty states; interaction tests for fold/unfold, Remove provider confirm; verify `ensureLoaded` runs on mount and `refresh()` fires only when stale.

**Agent verification checklist:**

1. Open settings → BYOK tab visible. Plugin reload + open Settings (without visiting BYOK) makes zero models.dev requests.
2. **First-time BYOK tab open**: skeleton shows briefly → `ensureLoaded()` resolves → table populates. Second open in the same session is instant (memory cache).
3. With migrated data: table populated with provider section rows; counts match `ModelRegistry.list().length`; model rows are display-only.
4. **No OpenCode or Copilot Plus rows in BYOK**, ever. Even when OpenCode is running, only BYOK providers (Anthropic / OpenAI / Ollama / etc.) appear.
5. Click chevron → section folds; click again → unfolds. State persists across modal open/close.
6. Provider section kebab → Remove provider → confirm → all that provider's rows disappear; restart plugin → still gone.
7. Click `[⚙ Configure]` on a provider section → opens legacy edit modal (placeholder until M5).
8. Click `[↻ Refresh catalog]` → spinner → timestamp updates; rows show any newly-released models.
9. Filter bar: type "claude" → only Anthropic section + Claude rows show; click `local` chip → filters to Ollama; clear → all sections back.
10. Mobile build: layout adapts; no OpenCode/Plus sections (they were never there).

---

### M5 — Configure Provider + Add Provider + Add Custom Model dialogs

**Goal:** All three new dialogs from §5.2 / §5.3, wired into the BYOK tab. After this milestone, users can complete the full BYOK flow without ever touching legacy UI.

**Deliverables:**

- `src/settings/v3/dialogs/AddProviderDialog.tsx`:
  - Provider picker with `Recommended` (Anthropic / OpenAI / Google) + `More providers` (alphabetical).
  - "Add a custom provider" CTA card at the bottom (dashed border, accent tint per the design).
  - Already-added providers filtered out.
- `src/settings/v3/dialogs/ConfigureProviderDialog.tsx` — single component supporting `state: "new-byok" | "new-custom" | "edit"`:
  - Header adapts (✓ Verified badge in edit state; no badge in new states per the design).
  - Connection fields with 120px label gutter. **No Availability row.**
  - API key field directly editable in all states (no "Replace" button); test button present.
  - Models section header: just "Models" subtitle; right side has `[+ Add from catalog]` (edit only) + `[+ Add custom model]`.
  - Filter bar: search + `All` / `≥ 200k ctx` / `≤ $1/M` / `Released ≤ 6mo` chips. **No Vision / Reasoning / Tool use chips.**
  - Model picker rows: checkbox + name + context + release date column. Edit state adds `⋯` kebab on registered rows (View docs / Remove from registry).
  - Sticky upstream-provider headers for OpenRouter.
  - Footer adapts (edit: `[Remove provider]` left, `[Save changes]` right; new: `[Verify & save]` right with selection count left).
  - On save: writes to `ProviderRegistry` + `ModelRegistry`; verification calls dispatched async, errors decorate rows with ⚠.
- `src/settings/v3/dialogs/AddCustomModelDialog.tsx`:
  - Three fields only: Display name, Model ID, Context window.
  - **No Capabilities checkboxes. No Availability row.** Capabilities default to `["chat", "agent"]`.
  - `[Test]` button next to Model ID.
- `src/settings/v3/components/ProviderCatalogList.tsx` — checklist used inside Configure Provider.
- BYOK provider section `[⚙ Configure]` button → opens **new** dialog in edit state.
- BYOK `[+ Add provider]` → opens **new** dialog flow.
- Tests: each dialog's states; verification happy + error paths; OpenRouter sticky-header rendering.

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

### M6 — Agent tab redesign (with Quick Chat sub-tab skeleton)

**Goal:** Replace the old Agent settings UI with the new Agent tab per §5.4. **Includes** the Quick Chat sub-tab as a UI skeleton (persistence + curation list working; actual chat-input → backend wiring is in the follow-up doc).

**Deliverables:**

- `src/settings/v3/tabs/AgentPanel.tsx` — top-level layout with `BackendSubtabs` and per-backend sub-panel.
- `src/settings/v3/components/BackendSubtabs.tsx` — four-way sub-tab strip (**OpenCode / Claude Code / Codex / Quick chat** — Quick chat last) with active-vs-viewed distinction.
- `src/settings/v3/components/BackendStatusCard.tsx` — shared status card with three states (`✓ Active backend` / `○ Configured, not active` / `⚠ Not installed`) and `[Use this backend]` / `[Reinstall]` / `[Browse…]` actions.
- `src/settings/v3/components/BackendModelPicker.tsx` — shared "Models in this backend's picker" component used by all four sub-tabs:
  - Header: title + sub-text ("tick which models show up when you switch model mid-session") + `Manage in BYOK →` link.
  - Rows: checkbox + name + provider (muted) + meta. No ★ default badge column.
  - Persists to `agentMode.backends.<id>.modelEnabledOverrides`.
- Per-backend sub-panels in `src/settings/v3/components/backends/`:
  - **OpencodePanel.tsx:** Status + BackendModelPicker sourced from `ModelRegistry.list({ capability: "agent" })`.
  - **ClaudeCodePanel.tsx / CodexPanel.tsx:** Status + Subscription card (re-auth) + BackendModelPicker sourced from the backend's bundled model list.
  - **QuickChatPanel.tsx (SKELETON):** Status (always "Active — runs in the plugin"; no install needed) + BackendModelPicker sourced from `ModelRegistry.list({ capability: "chat" })`. The picker writes to `agentMode.backends.quickChat.modelEnabledOverrides`. **No runtime routing wiring yet** — clicking around saves settings but the chat input still routes through the legacy ChatModelManager path. The follow-up doc connects the wires.

Per-backend "Default model" + "Default reasoning effort" controls were dropped in the model-settings redesign. New sessions inherit (model, effort) from the previous active session on the same backend via `AgentSessionManager.getLastSelection`; on a fresh plugin load the manager falls back to the backend's catalog default. Picker selections feed `AgentSessionManager.rememberLastSelection` rather than `setSettings`.

- `src/settings/v2/SettingsMainV2.tsx` — replace old Agent tab registration with new one.
- Tests: tab switch preserves state; `[Use this backend]` updates `agentMode.activeBackend`; picker persistence per backend.

**Agent verification checklist:**

1. Open Agent tab → 4 sub-tabs visible in order: OpenCode · Claude Code · Codex · Quick chat. OpenCode sub-tab active by default.
2. Status card shows correct state per backend.
3. Switch sub-tabs → panel changes; each preserves its own state.
4. Click `[Use this backend]` in Claude Code's status card → it becomes active; OpenCode flips to `○ Configured`.
5. OpenCode picker: tick/untick a model → reload plugin → state persists; chat input agent picker reflects.
6. Quick chat sub-tab: status card says active; picker lists all chat-capable models. Tick some models → save → restart → state persists. **Chat still routes through legacy path** — this is expected.

---

### M7 — _(skipped — Welcome modal is out of scope for this plan)_

The standalone Welcome modal designed in `final.jsx` is deferred to a separate workstream. The BYOK tab's existing empty state (one big `[+ Add provider]` CTA per §5.1) is the only first-run surface this plan ships. Milestone numbers M8/M9 are kept as-is to preserve cross-references; M7 is intentionally a no-op slot.

---

### M8 — BYOK→OpenCode agent bridge + OpenCode panel model sources

**Goal:** Make BYOK custom providers usable in agent mode (JTBD-17), and complete the OpenCode sub-tab's three-source picker (OpenCode-bundled ⊕ Copilot Plus ⊕ BYOK agent-capable). **OpenCode-bundled and Copilot Plus models stay out of the BYOK registry entirely.**

**Deliverables:**

- `src/agentMode/backends/opencode/byokBridge.ts` — on OpenCode startup (and on `ProviderRegistry` changes), register every BYOK provider into OpenCode's config. For built-in providers, just register the API key; for custom providers, register the full endpoint config.
- `src/agentMode/backends/opencode/bundledModels.ts` — sync wrapper that exposes OpenCode's enumeration of bundled models (Big Pickle, etc.) via a `listBundledModels(): Promise<BundledModel[]>` function. Reads from the running OpenCode binary's JSON-RPC or config; isolated here so the OpenCode panel doesn't have to know the wire format.
- `src/agentMode/backends/opencode/plusModels.ts` — same shape for Copilot Plus hosted models; gated by `isPlusUser`.
- `src/settings/v3/components/backends/OpencodePanel.tsx` (extended from M6 skeleton):
  - `BackendModelPicker` is replaced/wrapped to display three sources unioned:
    1. `listBundledModels()` rows (header: "OpenCode-bundled").
    2. `listPlusModels()` rows (header: "Copilot Plus", only when Plus active).
    3. `ModelRegistry.list({ capability: "agent" })` rows (header: "From BYOK").
  - Each row has a checkbox writing to `agentMode.backends.opencode.modelEnabledOverrides[<key>]`.
  - `<key>` format: the bare wire-form `baseModelId` the running OpenCode binary reports (e.g. `bigpickle/big-pickle`, `copilot-plus/copilot-plus-flash`, `anthropic/claude-sonnet-4-5`). The provider segment is intrinsic to the wire form, so two providers offering the same `modelId` never collide.
  - "OpenCode not installed" empty-state in the panel when source #1 is unavailable; the BYOK row sources still render so users can preview them.
- **No changes to `ByokGlobalTable.tsx`.** OpenCode-bundled and Plus models intentionally never appear in BYOK.
- Tests: bridge round-trip (BYOK custom provider → OpenCode config file → readable back); OpenCode panel renders all three sources correctly when present; missing sources hide their section header.

**Agent verification checklist:**

1. Add a local Ollama provider via BYOK → check OpenCode's config dir contains an entry for it. Ollama row appears in the OpenCode panel's "From BYOK" section.
2. Start an agent session in OpenCode → Ollama model appears in the in-session model picker → can execute a task using it.
3. With OpenCode running: OpenCode panel shows three sections (Bundled / Plus if applicable / From BYOK); BYOK tab shows **no** OpenCode rows.
4. Stop OpenCode → "OpenCode not installed" empty-state replaces the Bundled section; BYOK section in the panel still works; the BYOK tab is unaffected.
5. Re-enable OpenCode → all three sources back.
6. With Plus license: Plus section appears in OpenCode panel; BYOK tab is unaffected.

---

### M9 — Cleanup + final removals

**Goal:** Delete legacy code paths, remove "Models (legacy)" tab, finalize tab label renames, update docs.

**Deliverables:**

- Delete `src/settings/v2/components/ModelSettings.tsx`, `ModelAddDialog.tsx`, `ModelEditDialog.tsx`, the model-picker portion of `BasicSettings.tsx`.
- Delete legacy provider-key field references throughout the codebase (run grep from Appendix A; nothing should match).
- `src/settings/v2/SettingsMainV2.tsx` — remove "Models (legacy)" tab; rename "Basic" → "Chat", "Chat & Commands" → "Commands". (The QA → Embedding rename already shipped in M3.)
- `src/constants.ts` — `BUILTIN_CHAT_MODELS` removed (catalog replaces it). `BUILTIN_EMBEDDING_MODELS` kept (embedding side is unchanged by this redesign).
- Delete `src/LLMProviders/` (its contents moved into `src/modelManagement/` in M2).
- Update user-facing docs (`docs/llm-providers.md`, `docs/agent-mode-and-tools.md`) per the new UI.
- Update `AGENTS.md` migration notes section.
- Final `npm run lint && npm run format && npm run test && npm run build` pass clean.

**Agent verification checklist:**

1. `git grep openAIApiKey src/` returns nothing.
2. `git grep activeModels src/` only returns `activeEmbeddingModels` references.
3. `git grep BUILTIN_CHAT_MODELS src/` returns nothing.
4. `src/LLMProviders/` no longer exists.
5. Tab strip shows: Chat · BYOK · Agent · Commands · Embedding · Advanced. (No "Models", no "QA".)
6. `npm run lint && npm run test && npm run build` all green.
7. Manual smoke test:
   - Fresh install → BYOK empty state → `[+ Add provider]` → add provider → chat works.
   - Add custom Ollama → agent mode works in OpenCode.
   - Switch agent backend to Claude Code → agent session works.
   - Embedding tab → rebuild vector index → semantic search works.
8. Take "before" screenshots from M2 and "after" screenshots — UI complete per the design.

---

## 7. Cross-cutting verification artifacts

The implementing agent should maintain a `TODO.md` per `AGENTS.md` guidance for session-level tracking, plus produce these artifacts as deliverables of the whole series:

- `designdocs/MODEL_MANAGEMENT_IMPLEMENTATION_PROGRESS.md` — checked off as each milestone completes.
- Screenshots before/after each milestone (saved to `.context/screenshots/M<n>/`) — proves the UI works.
- Migration test fixtures under `src/settings/migrations/__tests__/fixtures/`:
  - `fixture-keys-only.json` — only provider keys.
  - `fixture-custom-provider-ollama.json` — local Ollama with two models.
  - `fixture-agent-overrides.json` — `modelEnabledOverrides` populated with old-format keys.
  - `fixture-overrides-everywhere.json` — every per-model override field set, plus `enabled: false`.
  - `fixture-azure-bedrock.json` — Azure + Bedrock with their extras.
  - `fixture-default-model-key.json` — `defaultModelKey` populated; verifies Quick Chat seeding.

---

## 8. Risks & known unknowns

| Risk                                                                | Mitigation                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models.dev/api.json` schema drift between runtime fetches          | Hand-rolled `.d.ts` + runtime Zod validation in `ModelCatalogService.refresh()`. Bad payload → log + keep last good source.                                                                                        |
| `models.dev` outage or CORS issue from Obsidian's environment       | Disk cache covers outage once we've fetched at least once; lazy fetch means most sessions never call out at all. CORS not a concern (Obsidian uses Node `fetch`).                                                  |
| Boundary eslint rule false positives during migration               | Add explicit `import/no-restricted-paths` allowances for transition files (`src/main.ts`, the legacy `chatModelManager` shim) until M9 removes them.                                                               |
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

### Future migration: CustomModel capability removal

`RegistryEntry.capabilities` has been removed. However, the legacy `CustomModel` type in `src/aiParams.ts` still carries its own pre-v2 `ModelCapability` enum (from `src/constants.ts`, values `REASONING` / `VISION` / `WEB_SEARCH`). The chat path still flows through `CustomModel`, and several consumers read `customModel.capabilities` to gate behavior.

These consumers stay as-is in this redesign and are scheduled for removal alongside a broader "chains stop supporting thinking blocks + vision gating moves to attach-time" cleanup:

| Site                                                                                                                                                                                                           | What it does today                                                                                                                  | Future action                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/LLMProviders/chainRunner/LLMChainRunner.ts:92`                                                                                                                                                            | Excludes thinking blocks for non-reasoning models (`excludeThinking`)                                                               | Drop the gate. Chains will not support thinking blocks; rely on output-side `<think>` stripping for open-weight reasoning models.                                                                                                                                                                                              |
| `src/LLMProviders/chainRunner/VaultQAChainRunner.ts:52`                                                                                                                                                        | Same                                                                                                                                | Same.                                                                                                                                                                                                                                                                                                                          |
| `src/LLMProviders/chainRunner/CopilotPlusChainRunner.ts` (vision gate around line 570, reasoning gate around line 755)                                                                                         | `hasCapability(model, VISION)` strips images when model is text-only; reasoning gate mirrors LLMChainRunner                         | Replace vision gate with attach-time check in `ChatInput.tsx` driven by `ModelCatalogService.getModel(...)?.modalities?.input?.includes("image")`. Drop the reasoning gate with the rest of the thinking-block work. For custom (non-catalog) models, add an opt-in `supportsVision` flag on the custom provider/model config. |
| `src/modelManagement/chatModel/ChatModelManager.ts:352-396, 593`                                                                                                                                               | Passes `enableReasoning` / `think` / `reasoning_effort` to OpenRouter / Ollama / LM Studio SDKs based on `customModel.capabilities` | Drop. We stop requesting thinking from any provider; default `reasoning_effort` is fine for the reasoning models that always reason internally (OpenAI o-series).                                                                                                                                                              |
| `src/components/ui/ModelParametersEditor.tsx:73-76`                                                                                                                                                            | Renders the reasoning-effort slider when the model has `REASONING` capability                                                       | Remove the slider with the rest of the thinking-block removal.                                                                                                                                                                                                                                                                 |
| `src/components/ui/model-display.tsx` (`ModelCapabilityIcons`), `src/settings/v2/components/ModelTable.tsx`, `src/settings/v2/components/ModelEditDialog.tsx`, `src/settings/v2/components/ModelAddDialog.tsx` | Render capability icons / checkboxes in the legacy CustomModel-based UI                                                             | Delete with `CustomModel.capabilities` and the legacy `ModelCapability` enum.                                                                                                                                                                                                                                                  |
| `src/constants.ts` (`ModelCapability` enum + `MODEL_CAPABILITIES` record) and `src/aiParams.ts` (`CustomModel.capabilities`)                                                                                   | Type-system home for the legacy enum                                                                                                | Delete once all consumers above are gone.                                                                                                                                                                                                                                                                                      |

These are deliberately separated from the registry-side cleanup: `RegistryEntry.capabilities` and `CustomModel.capabilities` are different fields on different types — removing the former does not constrain or require touching the latter.

---

## Appendix A — Pre-flight grep targets

Run these before starting M2 to map every legacy field consumer that needs updating to read via `ProviderRegistry`:

```
git grep -nE '(openAIApiKey|openAIOrgId|anthropicApiKey|googleApiKey|cohereApiKey|mistralApiKey|deepseekApiKey|groqApiKey|xaiApiKey|openRouterAiApiKey|siliconflowApiKey|amazonBedrockApiKey|amazonBedrockRegion|huggingfaceApiKey|azureOpenAI\w+|openAIProxyBaseUrl|openAIEmbeddingProxyBaseUrl|defaultModelKey|activeModels|agentMode\.enabled)' -- 'src/**'
```

Every match outside `src/settings/migrations/`, `src/settings/model.ts` (the type definition), and `src/services/ProviderRegistry.ts` is a call site to update.

---

## Appendix B — Final file inventory

| New files (M1–M9)                                                                                     | Purpose                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/modelManagement/index.ts`                                                                        | M1 public API barrel (single entry point)          |
| `src/modelManagement/types.ts`                                                                        | M1 shared types (ProviderConfig, RegistryEntry, …) |
| `src/modelManagement/providers/supportedProviders.ts`                                                 | M1 `SUPPORTED_PROVIDER_IDS`                        |
| `src/modelManagement/catalog/modelsCatalog.types.ts`                                                  | M1 catalog types                                   |
| `src/modelManagement/catalog/ModelCatalogService.ts`                                                  | M1 (lazy + 2-tier: memory → disk → live)           |
| ESLint config additions (`import/no-restricted-paths`)                                                | M1 boundary enforcement                            |
| `src/modelManagement/migrations/runMigrations.ts`                                                     | M2                                                 |
| `src/modelManagement/migrations/v0-to-v2.ts`                                                          | M2                                                 |
| `src/modelManagement/migrations/__tests__/v0-to-v2.test.ts` + fixtures                                | M2                                                 |
| `src/modelManagement/providers/ProviderRegistry.ts`                                                   | M2                                                 |
| `src/modelManagement/providers/adapters/*` (relocated from `src/LLMProviders/`)                       | M2                                                 |
| `src/modelManagement/registry/ModelRegistry.ts`                                                       | M2                                                 |
| `src/modelManagement/chatModel/ChatModelManager.ts`                                                   | M2 (refactored from src/LLMProviders)              |
| `src/modelManagement/chatModel/buildLangChainConfig.ts`                                               | M2                                                 |
| `src/settings/v2/components/EmbeddingModelsSection.tsx` (extracted from ModelSettings)                | M3                                                 |
| `src/modelManagement/ui/tabs/ByokPanel.tsx`                                                           | M4                                                 |
| `src/modelManagement/ui/components/ByokGlobalTable.tsx`                                               | M4                                                 |
| `src/modelManagement/ui/dialogs/{AddProviderDialog,ConfigureProviderDialog,AddCustomModelDialog}.tsx` | M5                                                 |
| `src/modelManagement/ui/components/ProviderCatalogList.tsx`                                           | M5                                                 |
| `src/settings/v3/tabs/AgentPanel.tsx`                                                                 | M6                                                 |
| `src/settings/v3/components/{BackendSubtabs,BackendStatusCard,BackendModelPicker}.tsx`                | M6                                                 |
| `src/settings/v3/components/backends/{Opencode,ClaudeCode,Codex,QuickChat}Panel.tsx`                  | M6                                                 |
| `src/agentMode/backends/opencode/byokBridge.ts`                                                       | M8                                                 |
| `src/agentMode/backends/opencode/bundledModels.ts`                                                    | M8                                                 |
| `src/agentMode/backends/opencode/plusModels.ts`                                                       | M8                                                 |
| `designdocs/MODEL_MANAGEMENT_IMPLEMENTATION_PROGRESS.md`                                              | Tracking artifact                                  |

| Deleted files (M9)                                                     | Reason                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/settings/v2/components/ModelSettings.tsx`                         | Replaced by ByokPanel + EmbeddingsPanel                                     |
| `src/settings/v2/components/ModelAddDialog.tsx`                        | Replaced by AddCustomModelDialog                                            |
| `src/settings/v2/components/ModelEditDialog.tsx`                       | Replaced by ConfigureProviderDialog                                         |
| Provider-key portion of `src/settings/v2/components/BasicSettings.tsx` | Replaced by ConfigureProviderDialog                                         |
| `src/LLMProviders/` (entire folder)                                    | Relocated to `src/modelManagement/providers/adapters/` + `chatModel/` in M2 |
| `BUILTIN_CHAT_MODELS` block of `src/constants.ts`                      | Replaced by `ModelCatalogService` (lazy live fetch + disk cache)            |

---

## Appendix C — Where this doc gets stored

This is the working spec the implementing agent should read.

- **`.context/plans/model-management-redesign-technical-design-impleme.md`** (this file) — canonical, shared with teammates.
- **On approval, copy to `designdocs/MODEL_MANAGEMENT_IMPLEMENTATION.md`** so it lives with the codebase. The two should be kept in sync; if either diverges, this `.context` file is the working draft.
- **`designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`** — the follow-up doc; owns the Quick Chat agent runtime.
