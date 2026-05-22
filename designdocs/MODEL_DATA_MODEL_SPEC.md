# Model Management — Data-Model Spec

> **Status.** This spec supersedes the data-model sections of
> `MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md`. UX flows, migration mechanics, and
> non-data-model sections of that doc still apply. The implementation
> currently on `zero/model-settings-redesign` does **not** fully match this
> spec — see the [Reconciliation appendix](#reconciliation-appendix) at the
> bottom for a candid diff. Decide what to keep, change, or rename after
> reading the design.

> **Audience.** A coding agent reconciling `src/modelManagement/` against this
> design, and reviewers vetting the data model before any code changes.

---

## 1. Scope & non-goals

### In scope

- Chat-model data model: providers, instances, catalog, custom models,
  enrollments, consumers, per-consumer model selection.
- Catalog wiring (`models.dev`).
- Per-pipeline reachability (LangChain vs. OpenCode byokBridge).
- BYOK ↔ agent-backend reconciliation (how a user-enrolled model surfaces
  in OpenCode).

### Out of scope (deliberately)

- **Embeddings parity.** The structurally identical pipeline (provider →
  enrollment → consumer) is sketched in §3.9 for reference, but actual
  rollout is deferred. The legacy `activeEmbeddingModels` /
  `embeddingModelKey` shape continues to work until embeddings are folded in.
- **Global chat knobs.** No `temperature` / `maxTokens` / `reasoningEffort` /
  `verbosity` / `topP` / `frequencyPenalty` settings live in the model
  data model. Adapters use their SDK defaults. If user-tunable knobs are
  ever needed, they belong elsewhere (per-invocation, per-skill,
  per-command) — not here.
- **Per-agent capability filtering at picker render.** Pickers show whatever
  the consumer has enabled. If a model is incompatible with the agent at
  runtime, the runtime error path surfaces that. Catalog capability metadata
  still exists for display badges; it doesn't silently hide models.
- **UX flows / dialog wireframes.** This spec is data-model only.
- **Migration mechanics.** Drop / rename moves are downstream — once the
  target data model is agreed, a separate plan covers the v0→v3 (or
  in-place v2→v3) migration.

---

## 2. Behaviors the data model must support

1. **Provider configuration.** The user configures a provider by picking a
   type (Anthropic, OpenAI, Google, Mistral, Groq, custom OpenAI-compatible,
   Ollama, LM Studio, Azure, Bedrock, …), supplying name / URL / key, and any
   per-adapter extras.

2. **Multiple instances of the same provider type.** The user can have two
   Anthropic credential sets ("prod" and "staging"), two Ollama endpoints,
   etc. Each instance is independently configured and enrolled. Per-instance
   display names disambiguate.

3. **Catalog drives the provider list.** The "Add Provider" UI iterates the
   `models.dev` catalog to show what's available.

4. **Catalog drives the model list per provider.** Once a provider is
   configured, the catalog tells us what models it serves.

5. **BYOK enrollment.** The user picks specific models from a provider to
   bring into the plugin's pool. This is a persistent decision, separate
   from "do I have a key for this provider."

6. **Custom models on custom providers.** For self-hosted endpoints
   (Ollama, LM Studio, etc.) the catalog has nothing — the user enters
   model details by hand.

7. **Per-use-case model selection.** Each consumer (Simple Chat, Vault QA,
   Project chain, OpenCode agent, Claude Code agent, Codex agent, Quick
   Chat, …) holds its own selection of which BYOK models it can use, and
   its own default. The same enrollment can be selected by several
   consumers.

8. **Backend-supplied additional models.** Agent backends (OpenCode
   bundled, Claude Code subscription, Codex subscription, Copilot Plus
   hosted) report models at runtime that aren't in BYOK. The picker for
   those consumers is the union of BYOK + backend-reported, intersected
   with the user's per-consumer selection.

9. **Per-pipeline reachability is declared, not assumed.** Each BYOK
   provider is reachable from one or both of two pipelines:
   - (a) the LangChain-based direct path (Simple Chat, Vault QA, Quick
     Chat, Project chain, custom commands)
   - (b) the OpenCode byokBridge path (the OpenCode agent backend)

   Single-pipeline support is acceptable. The data model captures which
   pipelines a `ProviderType` supports, and consumer pickers filter
   accordingly. Subscription-bundled agent backends (Claude Code, Codex)
   don't accept BYOK at all and sit outside this axis.

10. **Embeddings parity (deferred but architecturally allowed).** Embeddings
    follow the same five-layer pipeline (provider → enrollment → consumer).
    Their entities mirror the chat side; rollout is sequenced separately.

---

## 3. Entities

Seven persisted entities + two read-only entities (catalog metadata + runtime
inventory).

### 3.1 ProviderType (catalog-derived, read-only)

Describes a _kind_ of provider. Sourced from `models.dev` plus our own
corrections table. **Not persisted in user settings.**

```ts
interface ProviderType {
  /** Canonical catalog id: "anthropic", "openai", "google", "mistral",
   *  "groq", "deepseek", "together", "openrouter", "siliconflow", … */
  id: string;

  /** Display label. "Anthropic", "Mistral", … */
  displayName: string;

  /** Protocol/SDK we wire to. See §4 — closed at six values. */
  adapter: AdapterKind;

  /** Provider's published API URL (catalog-supplied). May be overridden
   *  per-instance via `ProviderInstance.baseUrl`. */
  defaultBaseUrl?: string;

  /** Credential scheme the user supplies. */
  auth: "api-key" | "oauth" | "none";

  /** Informational — env vars upstream tooling looks at. */
  envVars?: string[];

  /** Which pipelines can serve this provider. See §5.
   *  At least one must be true to appear in BYOK Add Provider. */
  pipelines: { langchain: boolean; opencode: boolean };

  /** Models keyed by id. See §3.3. Empty for synthetic types (ollama, lmstudio). */
  models: Record<string, CatalogModel>;
}

type AdapterKind =
  | "anthropic"
  | "openai-compatible"
  | "google"
  | "azure"
  | "bedrock"
  | "github-copilot";
```

Synthetic / non-BYOK ProviderTypes (no catalog model list):

| id                 | adapter             | auth   | pipelines                         | notes                                                              |
| ------------------ | ------------------- | ------ | --------------------------------- | ------------------------------------------------------------------ |
| `ollama`           | `openai-compatible` | `none` | `{langchain:true, opencode:true}` | Models come from `CustomModel`, not catalog.                       |
| `lmstudio`         | `openai-compatible` | `none` | `{langchain:true, opencode:true}` | Same as ollama.                                                    |
| `copilot-plus`     | n/a                 | n/a    | n/a                               | Pseudo-type for Copilot Plus hosted models; no `ProviderInstance`. |
| `opencode-bundled` | n/a                 | n/a    | n/a                               | Pseudo-type for OpenCode bundled models.                           |
| `claude-code-cli`  | n/a                 | n/a    | n/a                               | Subscription-bound; not BYOK.                                      |
| `codex-cli`        | n/a                 | n/a    | n/a                               | Subscription-bound; not BYOK.                                      |

### 3.2 ProviderInstance (persisted)

A user-configured credential set for a `ProviderType`. **Multiple instances of
the same `ProviderType` are allowed.**

```ts
interface ProviderInstance {
  /** UUID. Primary key. Also used as the keychain namespace
   *  (`provider-<instanceId>-apiKey`). */
  instanceId: string;

  /** FK to ProviderType.id. NON-UNIQUE — two Anthropic instances both have
   *  `providerTypeId: "anthropic"` with different `instanceId`. */
  providerTypeId: string;

  /** User-editable. Defaults to ProviderType.displayName. The UI suggests
   *  a numbered / qualified default ("Anthropic (prod)") when a second
   *  instance of the same type is added; uniqueness is recommended but
   *  not enforced by the data model. */
  displayName: string;

  /** Overrides ProviderType.defaultBaseUrl. */
  baseUrl?: string;

  /** Where the credential lives. `null` for auth=none providers. */
  apiKey?: KeychainRef | null;

  /** Adapter-specific opaque payload validated at instantiation time:
   *   - azure: { azureInstanceName, azureDeploymentName, azureApiVersion }
   *   - bedrock: { bedrockRegion }
   *   - openai (when used as adapter): { openAIOrgId }
   *  etc. */
  extras?: Record<string, unknown>;

  /** Bookkeeping. */
  addedAt: number;
  lastVerifiedAt?: number;
  lastVerificationError?: string;
}

type KeychainRef =
  | { kind: "keychain"; id: string } // OS keychain entry id, vault-scoped
  | { kind: "inline"; value: string }; // Plaintext fallback when keychain is unavailable
```

### 3.3 CatalogModel (catalog-derived, read-only)

```ts
interface CatalogModel {
  /** Wire-form id the provider's API accepts. "claude-sonnet-4-5". */
  id: string;
  displayName: string;
  family?: string;
  modalities: { input: string[]; output: string[] };
  limits: { context: number; output: number };
  capabilities: {
    reasoning?: boolean;
    toolCall?: boolean;
    attachment?: boolean;
    temperature?: boolean;
  };
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  knowledge?: string; // Training cutoff "2024-04"
  releaseDate?: string;
  lastUpdated?: string;
  openWeights?: boolean;
}
```

### 3.4 CustomModel (persisted)

For self-hosted endpoints. **Attached to a `ProviderInstance`, not a
`ProviderType`** — two Ollama instances on different machines can declare
different model lineups.

```ts
interface CustomModel {
  /** FK to ProviderInstance.instanceId. Must reference an instance whose
   *  ProviderType has an empty `models` map (synthetic / custom-typed). */
  instanceId: string;

  /** Wire form. "llama3.3:70b". */
  modelId: string;

  displayName: string;

  /** Declared by the user since no catalog metadata exists. */
  declaredCapabilities?: {
    reasoning?: boolean;
    toolCall?: boolean;
    attachment?: boolean;
  };
  contextLimit?: number;
  extras?: Record<string, unknown>; // ollama numCtx, etc.
  addedAt: number;
}
```

Storage: `settings.customModels: CustomModel[]`.

### 3.5 ByokEnrollment (persisted) — the unit of identity

The central persistent record. One row per `(instanceId, modelId)` pair the
user has enrolled. Pure pointer + per-user metadata. **The handle the rest of
the app holds onto.**

```ts
interface ByokEnrollment {
  /** FK to ProviderInstance.instanceId. */
  instanceId: string;

  /** Either a CatalogModel.id on the instance's ProviderType, or a
   *  CustomModel.modelId scoped to (instanceId, modelId). Never both. */
  modelId: string;

  /** Optional override of the catalog/custom displayName. */
  displayName: string;

  enrolledAt: number;

  /** Adapter-validated per-model knobs:
   *   - openrouter: { enablePromptCaching }
   *   - openai-compatible: { enableCors }
   *  This is NOT where temperature/maxTokens live — those don't exist
   *  in this data model at all. */
  overrides?: Record<string, unknown>;

  lastVerifiedAt?: number;
  lastVerificationError?: string;
}
```

**Stable enrollment key**: `enrollmentRef = ${instanceId}::${modelId}`. Used
everywhere downstream as a single string handle. The double colon avoids
collisions with provider / model ids that legitimately contain `/`.

**Multi-instance implication**: the same `modelId` can be enrolled twice if
the user has two `ProviderInstance` rows of the same `ProviderType`. Both are
first-class; the consumer chooses which credential to route through.

Storage: `settings.enrollments: ByokEnrollment[]`.

### 3.6 ConsumerConfig (persisted)

A consumer is anything that needs a model: Simple Chat, Vault QA, the
OpenCode agent backend, a custom command, etc. Each is identified by a
stable `ConsumerId`. Each holds its own selection.

```ts
type ConsumerId =
  | "chat" // Simple Chat
  | "vault-qa" // Vault QA chain
  | "project" // Project chain (per-project override layers on top — see Open Q)
  | "copilot-plus" // Copilot Plus chain
  | "quick-chat" // Quick-command chat
  | "agent:opencode" // OpenCode agent backend
  | "agent:claude-code" // Subscription-bound; ignores BYOK
  | "agent:codex" // Subscription-bound; ignores BYOK
  | `command:${string}`; // Custom commands that pin a model

interface ConsumerConfig {
  consumerId: ConsumerId;

  /** Curated allow-list of model references this consumer may use. */
  enabledModels: ConsumerModelRef[];

  /** Preferred default for this consumer, when applicable. */
  defaultModel?: ConsumerModelRef | null;
}
```

Storage: `settings.consumers: Record<ConsumerId, ConsumerConfig>`.

An empty `enabledModels: []` means "use the default-selection heuristic" (the
picker shows everything the consumer is eligible for; nothing is pinned).

### 3.7 ConsumerModelRef (polymorphic)

A consumer pins three kinds of model references:

```ts
type ConsumerModelRef =
  /** A model the user enrolled via BYOK. */
  | { source: "byok"; enrollmentRef: string }

  /** A model the agent backend bundles itself (not BYOK, not Plus). */
  | { source: "backend-bundled"; backendId: BackendId; backendModelId: string }

  /** A model hosted by Copilot Plus. */
  | { source: "copilot-plus"; modelId: string };

type BackendId = "opencode" | "claude-code" | "codex";
```

### 3.8 BackendInventory (runtime-only, NOT persisted)

At session start, each agent backend reports what models it can serve. Held
in memory; never written to settings.

```ts
interface BackendInventory {
  backendId: BackendId;
  models: BackendModelEntry[];
}

interface BackendModelEntry {
  /** What the backend speaks at runtime. */
  backendModelId: string;

  origin:
    | { kind: "bundled" } // Agent's own enumeration
    | { kind: "byok"; enrollmentRef: string } // Bridged from user's BYOK
    | { kind: "copilot-plus" }; // Hosted by Plus

  displayName?: string;
  capabilities?: CatalogModel["capabilities"]; // If known
}
```

### 3.9 Embeddings (deferred)

Embedding-side mirrors the chat-side entities. Out of scope for this rollout
but the spec reserves the shape so a follow-up doesn't have to redesign:

```ts
type EmbeddingConsumerId =
  | "vault-index" // The vector store for vault QA
  | "project-index"; // Project-specific embedding (TBD)

interface EmbeddingConsumerConfig {
  consumerId: EmbeddingConsumerId;
  enabledModels: ConsumerModelRef[];
  defaultModel?: ConsumerModelRef | null;
}
```

Embedding-capability detection: `CatalogModel.modalities.output.includes("embedding")`
(or whatever marker `models.dev` settles on). Until rolled in, the legacy
`activeEmbeddingModels` + `embeddingModelKey` fields continue to work.

---

## 4. AdapterKind rationale

`AdapterKind` is **not** the same thing as `ProviderType.id`. The id is the
catalog handle (one per `models.dev` entry — potentially 30+). The adapter is
the protocol / SDK we wire to internally — closed at six values.

| AdapterKind         | LangChain path                                        | OpenCode path                         |
| ------------------- | ----------------------------------------------------- | ------------------------------------- |
| `anthropic`         | `@langchain/anthropic` (`ChatAnthropic`)              | `provider.set type=anthropic`         |
| `openai-compatible` | `@langchain/openai` (`ChatOpenAI` + custom `baseUrl`) | `provider.set type=openai-compatible` |
| `google`            | `@langchain/google-genai`                             | `provider.set type=google`            |
| `azure`             | `@langchain/openai` (Azure path) + deployment knobs   | `provider.set type=azure`             |
| `bedrock`           | `@langchain/aws`                                      | `provider.set type=bedrock`           |
| `github-copilot`    | Custom bridge (OAuth-based)                           | `provider.set type=github-copilot`    |

Why exactly these six:

- Each one is **wired** in both pipelines (or is openly understood to be
  one-pipeline-only via `ProviderType.pipelines`). Adding an `AdapterKind`
  is a real lift — you must ship LangChain code AND ensure OpenCode (or
  document the one-pipeline limitation).
- The catalog (30+ providers) maps onto these six. Most providers ride on
  `openai-compatible` with their own `defaultBaseUrl` from the catalog. A
  hypothetical seventh adapter is only justified if a real provider's
  protocol doesn't fit any of these six.

**The catalog list shown in "Add Provider"** mirrors the full `models.dev`
provider set — dozens of entries. The provider→adapter mapping is part of the
plugin's catalog corrections layer (seeded from `models.dev`, hand-edited
where the catalog is silent). Providers whose adapter we don't support yet
are shown with a "not yet supported in this plugin" affordance — surfaced,
not silently filtered.

---

## 5. Pipeline compatibility

`ProviderType.pipelines: { langchain: boolean; opencode: boolean }` is a
**load-bearing field**. It decides which `Consumer` pickers a provider's
enrollments can appear in.

### 5.1 Consumer ↔ pipeline mapping

| ConsumerId          | Pipeline       |
| ------------------- | -------------- |
| `chat`              | `langchain`    |
| `vault-qa`          | `langchain`    |
| `project`           | `langchain`    |
| `copilot-plus`      | `langchain`    |
| `quick-chat`        | `langchain`    |
| `command:*`         | `langchain`    |
| `agent:opencode`    | `opencode`     |
| `agent:claude-code` | (subscription) |
| `agent:codex`       | (subscription) |

Subscription consumers (`agent:claude-code`, `agent:codex`) don't accept
BYOK at all. Their `enabledModels` are all `backend-bundled` refs.

### 5.2 What causes a flag to flip false

**`pipelines.langchain = false`** (OpenCode-only):

- No LangChain SDK package available, and the provider's API isn't close
  enough to OpenAI's for `@langchain/openai` + a custom `baseUrl` to work.
- Provider uses an auth scheme the in-process LangChain code can't bind
  to: a CLI-issued session token, a hardware token, an OAuth flow that
  requires browser interaction the OpenCode CLI handles but we can't
  reproduce in-process.
- OpenCode bundles the integration end-to-end (SDK + OAuth) and exposing
  the same provider through LangChain would require shipping that SDK in
  the plugin bundle.

**`pipelines.opencode = false`** (LangChain-only):

- OpenCode's `provider.set` config doesn't recognize the protocol — we
  have a LangChain integration but OpenCode upstream hasn't wired it up.
- Provider needs per-request state (custom headers, signed URLs) the
  byokBridge has no way to inject into OpenCode's HTTP client.
- A local endpoint OpenCode's subprocess can't reach (rare).

**Both true** — the common case. Anthropic, OpenAI, Google, Mistral, Groq,
DeepSeek, Together, xAI, OpenRouter, etc.

**Both false** — does not appear in BYOK. If `models.dev` lists such a
provider, the Add Provider UI shows it with a "not yet supported" tooltip
so the user knows the gap exists.

### 5.3 Worked examples

| ProviderType.id  | adapter             | langchain | opencode | Notes                                                            |
| ---------------- | ------------------- | --------- | -------- | ---------------------------------------------------------------- |
| `anthropic`      | `anthropic`         | ✓         | ✓        |                                                                  |
| `openai`         | `openai-compatible` | ✓         | ✓        |                                                                  |
| `google`         | `google`            | ✓         | ✓        |                                                                  |
| `mistral`        | `openai-compatible` | ✓         | ✓        |                                                                  |
| `groq`           | `openai-compatible` | ✓         | ✓        |                                                                  |
| `openrouter`     | `openai-compatible` | ✓         | ✓        |                                                                  |
| `bedrock`        | `bedrock`           | ✓         | ✓        | Both pipelines wire AWS SDK auth differently.                    |
| `azure`          | `azure`             | ✓         | ✓        | Per-instance `extras` carries deployment name + API version.     |
| `github-copilot` | `github-copilot`    | ✓         | ✓        | OAuth token refresh handled in both pipelines.                   |
| `ollama`         | `openai-compatible` | ✓         | ✓        | Synthetic type; CustomModels per instance.                       |
| (hypothetical)   | `openai-compatible` | ✓         | ✗        | LangChain works; OpenCode upstream doesn't know the provider id. |
| (hypothetical)   | (custom OAuth)      | ✗         | ✓        | OpenCode CLI manages OAuth; we can't replicate in-process.       |

---

## 6. Top-level settings shape

```ts
interface CopilotSettings {
  // … existing non-model fields …

  settingsVersion: number;
  providers: Record<string /* instanceId */, ProviderInstance>;
  customModels: CustomModel[]; // keyed by (instanceId, modelId)
  enrollments: ByokEnrollment[]; // keyed by (instanceId, modelId)
  consumers: Record<ConsumerId, ConsumerConfig>;

  // Out-of-scope but reserved:
  // embeddingConsumers: Record<EmbeddingConsumerId, EmbeddingConsumerConfig>;
  // (or keep legacy activeEmbeddingModels + embeddingModelKey until embeddings parity ships)
}
```

ProviderType / CatalogModel are catalog data, not settings.

---

## 7. Invariants

| #   | Invariant                                                                                                                                                                                                                      | Checked by                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| 1   | `enrollment.instanceId ∈ keys(providers)`                                                                                                                                                                                      | Write path, migration       |
| 2   | `(instanceId, modelId)` pair resolves either via the instance's ProviderType catalog OR via a `CustomModel` row — never both                                                                                                   | Write path                  |
| 3   | At most one `ByokEnrollment` per `(instanceId, modelId)`                                                                                                                                                                       | Write path                  |
| 4   | At most one `CustomModel` per `(instanceId, modelId)`                                                                                                                                                                          | Write path                  |
| 5   | If `ProviderType.auth = "api-key"`, `ProviderInstance.apiKey` is non-null; otherwise the provider is "incomplete" and its enrollments are greyed in pickers                                                                    | Runtime                     |
| 6   | Every `ConsumerModelRef` with `source = "byok"` points at a present enrollment; broken refs surface in the UI, never silently pruned                                                                                           | Runtime                     |
| 7   | When a consumer's `defaultModel` is removed from `enabledModels`, `defaultModel` is set to `null`                                                                                                                              | Write path                  |
| 8   | Deleting a `ProviderInstance` cascades to its `ByokEnrollment` rows and its `CustomModel` rows. Consumer refs pointing at those enrollments become broken refs (surfaced; not pruned)                                          | Write path                  |
| 9   | A consumer whose pipeline is `langchain` only renders enrollments whose `ProviderType.pipelines.langchain = true`; same for `opencode`. Ineligible enrollments are shown as ineligible in BYOK panel (with reason), not hidden | Runtime                     |
| 10  | NO `providerTypeId` uniqueness constraint across `providers` (multi-instance is the whole point)                                                                                                                               | — (explicit non-constraint) |

---

## 8. Resolution traces

End-to-end walks of common flows. The HTML companion renders these as
sequence-style ASCII; this Markdown keeps the prose form.

### Trace A — Simple Chat, single OpenAI instance

1. User opens BYOK panel → catalog shows OpenAI models.
2. User adds OpenAI provider →
   `ProviderInstance{ instanceId: "openai-uuid-1", providerTypeId: "openai", apiKey: K }`.
3. User enrolls `gpt-5` →
   `ByokEnrollment{ instanceId: "openai-uuid-1", modelId: "gpt-5" }`.
4. User opens Simple Chat settings → enables it →
   `ConsumerConfig{ consumerId: "chat", enabledModels: [{source:"byok", enrollmentRef:"openai-uuid-1::gpt-5"}] }`.
5. User sets it as default → `ConsumerConfig.defaultModel` = same ref.
6. Chat picker iterates `chat.enabledModels`, resolves each through
   `enrollments` + catalog, renders "GPT-5".

### Trace B — OpenCode-bundled model (not BYOK)

1. Plugin starts → OpenCode CLI launched → reports inventory including
   `bigpickle/big-pickle` (bundled).
2. User opens Agent settings for OpenCode → enables it →
   `ConsumerConfig{ consumerId: "agent:opencode", enabledModels: [{source:"backend-bundled", backendId:"opencode", backendModelId:"bigpickle/big-pickle"}] }`.
3. Picker resolves the ref against the live `BackendInventory["opencode"]`
   and renders.

### Trace C — BYOK shared with OpenCode (byokBridge)

1. Existing enrollment: `anthropic-prod-uuid::claude-sonnet-4-5` on the
   "Anthropic (prod)" instance.
2. User enables it in the OpenCode consumer →
   `ConsumerConfig{ enabledModels: [..., {source:"byok", enrollmentRef:"anthropic-prod-uuid::claude-sonnet-4-5"}] }`.
3. At runtime, byokBridge has registered the prod Anthropic credentials with
   OpenCode (one bridged provider per `ProviderInstance`, keyed by
   `instanceId`). OpenCode's inventory now includes a
   `backendModelId: "<bridged-id>/claude-sonnet-4-5"` entry with
   `origin: { kind: "byok", enrollmentRef: "anthropic-prod-uuid::claude-sonnet-4-5" }`.
4. Picker reconciles the consumer's `byok` ref with the inventory entry by
   `enrollmentRef`. If the user also enabled the staging-instance enrollment
   under OpenCode, both appear as separate entries — same model name, two
   credentials — disambiguated by their parent `ProviderInstance.displayName`.

### Trace D — Multi-instance catalog-backed (two Anthropic keys)

1. User has `ProviderInstance{ instanceId: "anthropic-prod-uuid", providerTypeId: "anthropic", displayName: "Anthropic (prod)", apiKey: K1 }`.
2. User clicks "Add Provider → Anthropic" again. **The BYOK UI does not
   filter Anthropic out** (multi-instance is allowed). A second instance is
   created: `ProviderInstance{ instanceId: "anthropic-staging-uuid", providerTypeId: "anthropic", displayName: "Anthropic (staging)", apiKey: K2 }`.
   The UI suggests the "(staging)" suffix on collision; user may rename.
3. User enrolls Claude Sonnet 4.5 on both → two enrollments,
   `anthropic-prod-uuid::claude-sonnet-4-5` and
   `anthropic-staging-uuid::claude-sonnet-4-5`. Catalog metadata identical;
   credentials different.
4. Simple Chat can enable either or both. The picker renders them as two
   rows, labeled by their parent instance's `displayName`.
5. Deleting the staging instance cascades: its enrollment is removed; any
   consumer ref pointing at it becomes broken (surfaced in UI). The prod
   enrollment is untouched.

### Trace E — Custom provider, multi-instance, custom models

1. User adds "Local Ollama" →
   `ProviderInstance{ instanceId: "ollama-uuid-1", providerTypeId: "ollama", displayName: "Ollama (laptop)", baseUrl: "http://localhost:11434", apiKey: null }`.
   `ProviderType` `"ollama"` is shared and has no catalog models.
2. User adds a second Ollama on a different machine →
   `ProviderInstance{ instanceId: "ollama-uuid-2", providerTypeId: "ollama", displayName: "Ollama (workstation)", baseUrl: "http://192.168.1.50:11434" }`.
3. User declares model lineups:
   `CustomModel{ instanceId: "ollama-uuid-1", modelId: "llama3.3:70b" }` and
   `CustomModel{ instanceId: "ollama-uuid-2", modelId: "mistral:7b" }`. Each
   instance owns its own list.
4. User enrolls them → two `ByokEnrollment` rows. From here, same path as
   Trace A.

---

## 9. Per-consumer picker formulas

For each consumer at picker-render time:

```
visibleEntries(consumerId) =
    let pipeline = pipelineOf(consumerId)
    let inventory = (pipeline === "opencode")
        ? BackendInventory[backendIdOf(consumerId)]
        : null

    enabled = consumer.enabledModels         // empty ⇒ fall back to default-selection heuristic

    for each ref in enabled:
        case ref.source:
          "byok":
            let e = enrollments[ref.enrollmentRef]
            let p = providers[e.instanceId]
            let t = providerTypes[p.providerTypeId]
            require t.pipelines[pipeline]
            require p.apiKey != null OR t.auth == "none"
            if pipeline == "opencode":
              find matching inventory entry by enrollmentRef
            emit entry

          "backend-bundled":
            require inventory != null && inventory.includes(ref.backendModelId)
            emit entry

          "copilot-plus":
            require copilotPlusCatalog.includes(ref.modelId)
            emit entry
```

No capability filtering. No runtime "this model doesn't do tool calls so
hide it" check — the runtime error path surfaces incompatibility.

---

## 10. Open questions

These remain unresolved by this spec — to be answered before implementation
starts.

1. **Embeddings unification timing.** Stay legacy for now? Or fold in as a
   follow-up after the chat side stabilizes?
2. **Project-level chain default storage.** Currently `ProjectConfig.projectModelKey`
   holds a wire-form string. Does it become `ProjectConfig.defaultModelRef:
ConsumerModelRef | null`? Does each project override `consumers["project"]`
   wholesale, or just the default?
3. **Per-invocation knobs.** If we ever surface a user-facing temperature
   slider, where does it live? Per-message? Per-skill? Per-command? Spec
   says "not in the data model" — does that hold?
4. **"Not yet supported in this plugin" affordance.** How does the Add
   Provider UI render a `models.dev` provider whose adapter isn't in our
   six? Disabled list item with tooltip? Separate section? Out of scope
   here but downstream UX work depends on the answer.
5. **Per-pipeline-only badging.** Do we surface "works with chat only" /
   "works with OpenCode only" copy on the BYOK enrollment row? Or surface
   it only at the provider level?
6. **`backend-bundled` ref staleness.** Backend inventories change between
   OpenCode releases. If a previously bundled model disappears, the
   consumer's ref becomes broken. Surface as a broken ref (mirrors BYOK
   broken-ref behavior) or auto-prune?
7. **Custom command consumers.** `command:<id>` consumers proliferate. Do
   we store one `ConsumerConfig` per command, or fold them into a single
   record keyed by command id internally?

---

## Reconciliation appendix

Descriptive diff between this spec and `src/modelManagement/` on
`zero/model-settings-redesign` (as of the writing of this doc). No
prescription — the user decides whether the spec bends to match the code or
vice versa.

### A.1 Provider records

- **Spec**: `providers: Record<instanceId, ProviderInstance>` where
  `providerTypeId` is a non-unique FK; multi-instance allowed.
- **Branch**: `providers: Record<ProviderId, ProviderConfig>` keyed by the
  _provider type id_ itself ("anthropic", "openai", "custom:<uuid>", …).
  **Singleton per type** — the BYOK Add Provider dialog filters out already-
  configured providers, so multiple Anthropic keys are impossible without
  routing through a `custom:<uuid>` workaround. (See
  `src/modelManagement/types.ts` `ProviderConfig`, and
  `src/modelManagement/ui/dialogs/AddProviderDialog.tsx`.)
- **Branch has** a `kind: "builtin" | "custom" | "system"` discriminator on
  `ProviderConfig` to support system providers (`opencode`, `copilot-plus`)
  as first-class entries solely to satisfy the FK invariant of
  `RegistryEntry.providerId`.
- **Spec does not** make system providers first-class `ProviderInstance`
  rows — they sit as pseudo-`ProviderType`s with no instance. The FK
  invariant on enrollments is unaffected because those models are not
  `ByokEnrollment` records to begin with; they're `ConsumerModelRef`s of
  `source: "backend-bundled" | "copilot-plus"`.

### A.2 ProviderType / catalog

- **Spec**: explicit `ProviderType` entity with `adapter: AdapterKind`,
  `pipelines: {langchain, opencode}`, `auth`, `defaultBaseUrl`, `models:
Record<id, CatalogModel>`.
- **Branch**: catalog lives in `ModelCatalogService` (`src/modelManagement/catalog/`)
  with `CatalogProvider` / `CatalogModel` types that mostly match the spec's
  shape, **minus** the `pipelines` field and minus an explicit `adapter`
  declaration. Provider→adapter mapping is implicit in the chat-model
  factory; pipeline reachability isn't modeled at all.

### A.3 Enrollment record

- **Spec**: `ByokEnrollment` with `instanceId` FK, `displayName`,
  `enrolledAt`, optional `overrides`, verification timestamps. Stable key
  `${instanceId}::${modelId}`.
- **Branch**: `RegistryEntry` (`src/modelManagement/types.ts`) with
  `providerId` (which is the singleton type id, not an `instanceId`),
  `modelId`, `displayName`, `addedAt`, `lastVerifiedAt`,
  `lastVerificationError`, optional `extra`. Functionally close, but
  identity is `(providerId, modelId)` instead of `(instanceId, modelId)`,
  which forecloses multi-instance.

### A.4 Custom models

- **Spec**: separate `customModels: CustomModel[]` table, FK'd to
  `instanceId`, intentionally distinct from `ByokEnrollment` — a user
  declares the model exists, then separately enrolls it.
- **Branch**: no `customModels` table. A "custom model" is simply a
  `RegistryEntry` whose `providerId` is a `custom:<uuid>` provider. Catalog
  has no record of it; the entry IS the declaration. Functionally works,
  but conflates "this model exists" with "I want to use this model" — the
  user can't list out their declared-but-not-enrolled models.

### A.5 Per-consumer model selection

- **Spec**: `consumers: Record<ConsumerId, ConsumerConfig>` with explicit
  per-consumer `enabledModels: ConsumerModelRef[]` and `defaultModel`. A
  single `ConsumerModelRef` shape (polymorphic) handles BYOK, backend-
  bundled, and Copilot Plus uniformly.
- **Branch**: per-backend `modelEnabledOverrides: Record<string, boolean>`
  with **per-backend-different key formats** (OpenCode uses
  `<providerId>/<modelId>`, Claude/Codex use bare model ids, Quick Chat
  uses `<providerId>:<modelId>`). Not a single uniform shape; relies on
  tribal knowledge about which key format each backend expects. (See
  `src/agentMode/session/modelEnable.ts` and migration step 6 in
  `src/modelManagement/migrations/v0-to-v2.ts`.)
- **Branch missing**: `consumers` for LangChain-side use cases (Simple Chat,
  Vault QA, Project, Quick Chat). The current model still uses
  `settings.defaultModelRef: { providerId, modelId } | null` as a single
  "default chat model" pointer with no per-consumer allow-list.

### A.6 Default model representation

- **Spec**: every `ConsumerConfig` has its own `defaultModel: ConsumerModelRef | null`.
- **Branch**: `settings.defaultModelRef: { providerId, modelId } | null` is
  a single global chat default. No per-consumer defaults beyond what
  `agentMode.backends.<id>.defaultModel` carries for agent consumers.

### A.7 Pipeline compatibility

- **Spec**: `ProviderType.pipelines = {langchain, opencode}` is a first-
  class field that drives per-consumer picker visibility.
- **Branch**: not modeled. The byokBridge attempts to register every BYOK
  provider with OpenCode regardless of whether OpenCode actually supports
  that provider type. Failures surface at runtime, not at the data model
  level.

### A.8 Capabilities & global knobs

- **Spec**: no `capabilities` on `ByokEnrollment`; no global chat knobs in
  the data model; no per-agent capability filtering.
- **Branch**: matches the spec on `RegistryEntry` (no capabilities stored).
  **Differs** on global knobs — `temperature`, `maxTokens`, `reasoningEffort`,
  `verbosity` still live in `CopilotSettings` and feed every chat invocation
  via `ChatDefaults` (`src/modelManagement/types.ts`). The spec drops these.

### A.9 Embedding side

- **Spec**: parallel structure, deferred. Legacy `activeEmbeddingModels` +
  `embeddingModelKey` stays in the interim.
- **Branch**: matches (legacy embedding fields untouched on `CopilotSettings`).

### A.10 Migration status

- **Spec**: assumes the agreed target shape is the destination. Migration
  from current (v2) → target shape is a separate task, not specified here.
- **Branch**: `runModelManagementMigrations` runs a v0→v2 migration today.
  A v2→v3 migration to land this spec needs to:
  - Synthesize `instanceId`s for existing single-instance providers.
  - Translate `RegistryEntry` → `ByokEnrollment` (keying change).
  - Extract custom-provider `RegistryEntry`s into `CustomModel` rows + new
    `ByokEnrollment`s.
  - Translate per-backend `modelEnabledOverrides` into `ConsumerConfig`s
    for the agent consumers; create new `ConsumerConfig`s for LangChain
    consumers (probably initialized as "everything enabled" to preserve
    current behavior).
  - Add `pipelines: {langchain, opencode}` to the catalog corrections
    layer.
