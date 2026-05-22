/**
 * Pure helper that shapes the BYOK provider + model registry into OpenCode's
 * spawn-time `provider.<id>` slice.
 *
 * Per M8 of the Model Management redesign (designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §6):
 * BYOK is the single source of truth for user-brought providers and models.
 * OpenCode consumes those at spawn time via `OPENCODE_CONFIG_CONTENT`, built
 * by `OpencodeBackend.buildOpencodeConfig` — which calls this helper.
 *
 *   - Built-in providers (`kind: "builtin"`): register `{ options: { apiKey } }`
 *     under the canonical provider id (e.g. `anthropic`, `openai`). OpenCode
 *     already knows about these via its bundled models.dev snapshot, so the
 *     auth slice is all we add. Built-ins without a key are skipped — OpenCode
 *     would reject them anyway.
 *   - Custom providers (`kind: "custom"`): register the full endpoint config
 *     under the BYOK provider id (e.g. `custom:abc-…`). For these we pick
 *     the `@ai-sdk/openai-compatible` npm package — the only openai-format
 *     glue OpenCode ships with that supports an arbitrary base URL.
 *   - Each provider's BYOK registry entries are emitted as
 *     `provider.<id>.models.<modelId> = {}` so OpenCode lists them in
 *     `availableModels`. For custom providers this is the *only* way the
 *     models become visible (no models.dev snapshot for `custom:<uuid>`);
 *     for built-ins it's additive on top of the snapshot.
 */
import { ModelRegistry, ProviderRegistry, getProviderApiKeySync } from "@/modelManagement";
import { logInfo } from "@/logger";

const BYOK_DIAG = true;

/**
 * One OpenCode provider config entry as it appears under
 * `OPENCODE_CONFIG_CONTENT.provider.<id>`. Mirrors the shape `OpencodeBackend`
 * already uses for built-in providers + the Copilot Plus glue entry.
 */
export interface OpencodeProviderEntry {
  /** npm module OpenCode should load — only present for custom providers. */
  npm?: string;
  /** Display label OpenCode uses in its picker. */
  name?: string;
  /** OpenCode-native options bag: API key + base URL + extra headers. */
  options?: {
    apiKey?: string;
    baseURL?: string;
    headers?: Record<string, string>;
  };
  /**
   * Models OpenCode should surface under this provider in `availableModels`.
   * Empty object per model — opencode merges field-wise with its bundled
   * snapshot for built-ins, and treats this as the canonical list for
   * custom providers.
   */
  models?: Record<string, Record<string, unknown>>;
}

/** Map keyed by provider id, written under `OPENCODE_CONFIG_CONTENT.provider`. */
export type OpencodeProviderMap = Record<string, OpencodeProviderEntry>;

/**
 * Resolve the OpenCode provider id for a BYOK provider config.
 *
 * Both built-ins and customs already carry their canonical id on the
 * BYOK side (`openai`, `anthropic`, `openrouter`, `groq`, `xai`,
 * `custom:<uuid>`, …) — the same id OpenCode uses for its bundled
 * `models.dev` snapshot and for the wire-form leading segment in
 * `availableModels`. Translating on `provider.type` is wrong: it
 * collapses every `openai-compatible` built-in (openrouter, groq,
 * xai, mistral, deepseek, cohere, siliconflow, …) onto a single
 * `openai` slot, which clobbers the user's choices and breaks the
 * BYOK ↔ picker classifier in `bundledModels.ts:classifyOpencodeModels`.
 */
function resolveOpencodeProviderId(provider: { id: string }): string {
  return provider.id;
}

/**
 * Build the `OpencodeProviderMap` for every BYOK provider currently in the
 * registry, including the `models` sub-map sourced from `ModelRegistry`.
 * Pure — does no I/O beyond reading the two registries. Providers with no
 * API key (built-in only) are skipped (OpenCode would reject them anyway);
 * custom providers without a key are kept so local endpoints like Ollama
 * still wire through.
 */
export function buildByokOpencodeProviderConfig(
  providerRegistry: ProviderRegistry,
  modelRegistry: ModelRegistry
): OpencodeProviderMap {
  const map: OpencodeProviderMap = {};
  for (const provider of providerRegistry.list()) {
    // System providers (e.g. `opencode`, `copilot-plus`) are credentialed by
    // the agent backend itself, not by BYOK. The OpenCode backend writes
    // their config slice directly in `buildOpencodeConfig` (see
    // `OpencodeBackend.ts`), so we skip them here to avoid double-registering
    // and to keep the bridge's BYOK invariant (apiKey-or-skip) intact.
    if (provider.kind === "system") {
      if (BYOK_DIAG) {
        logInfo("[BYOK-DIAG] byokBridge skip system provider", {
          providerRegistryId: provider.id,
          kind: provider.kind,
        });
      }
      continue;
    }
    const apiKey = getProviderApiKeySync(provider.id);
    if (provider.kind === "builtin" && !apiKey) {
      if (BYOK_DIAG) {
        logInfo("[BYOK-DIAG] byokBridge skip builtin without apiKey", {
          providerRegistryId: provider.id,
          kind: provider.kind,
          type: provider.type,
          modelIds: modelRegistry.list({ providerId: provider.id }).map((m) => m.modelId),
        });
      }
      continue;
    }
    const opencodeId = resolveOpencodeProviderId(provider);
    const entry: OpencodeProviderEntry = { options: {} };
    if (provider.kind === "custom") {
      entry.npm = "@ai-sdk/openai-compatible";
      entry.name = provider.displayName;
      if (provider.baseUrl) entry.options!.baseURL = provider.baseUrl;
    }
    if (apiKey) entry.options!.apiKey = apiKey;
    if (!entry.options || Object.keys(entry.options).length === 0) delete entry.options;

    const registryModels = modelRegistry.list({ providerId: provider.id });
    if (registryModels.length > 0) {
      const models: Record<string, Record<string, unknown>> = {};
      for (const reg of registryModels) models[reg.modelId] = {};
      entry.models = models;
    }

    map[opencodeId] = entry;
    if (BYOK_DIAG) {
      logInfo("[BYOK-DIAG] byokBridge wire", {
        providerRegistryId: provider.id,
        kind: provider.kind,
        type: provider.type,
        opencodeId,
        hasApiKey: !!apiKey,
        modelIds: registryModels.map((m) => m.modelId),
      });
    }
  }
  if (BYOK_DIAG) {
    logInfo("[BYOK-DIAG] byokBridge final map", {
      opencodeProviderIds: Object.keys(map),
      perProviderModelCount: Object.fromEntries(
        Object.entries(map).map(([k, v]) => [k, Object.keys(v.models ?? {}).length])
      ),
    });
  }
  return map;
}
