/**
 * `ChatModelFactory` — central dispatcher that turns a provider + model +
 * defaults into a fully-instantiated LangChain `BaseChatModel`.
 *
 * Per-provider construction logic lives in the adapter files under
 * `src/modelManagement/providers/adapters/`. Each adapter exports a
 * `buildChatModel(input)` function; this factory looks up the right one
 * via the adapter registry and delegates.
 *
 * Callers go through this single entry point instead of the legacy
 * `ChatModelManager.getModelConfig` switch (see
 * `designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md` §3.4 and §3.6).
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService";
import { ADAPTERS } from "@/modelManagement/providers/adapters";
import type { ChatDefaults, ProviderConfig, RegistryEntry } from "@/modelManagement/types";

/**
 * Optional per-call overrides. Used by `ping` to swap `maxTokens` for a
 * cheap connectivity check, force non-streaming, and override the CORS
 * fetch wrapper for the retry-with-cors fallback path.
 */
export interface BuildChatModelOverrides {
  /** Override the resolved max-output-tokens budget. */
  maxTokens?: number;
  /** Force streaming off (used by ping which calls `.invoke()` only). */
  forceNonStreaming?: boolean;
  /**
   * Override `enableCors` for this call. Used by `ping` to retry through
   * Obsidian's `requestUrl` wrapper after a CORS-failed attempt.
   */
  enableCors?: boolean;
}

/**
 * Input every adapter's `buildChatModel` receives.
 *
 * All per-model overrides live on `entry.extra` (populated by the v0→v2
 * migration); provider-level config (baseUrl, credentials, OpenAI org id,
 * Azure deployment defaults, Bedrock region) lives on `provider` and
 * `provider.extra`. Global per-call knobs (`temperature`, `maxTokens`,
 * `reasoningEffort`, `verbosity`, `streaming`) flow through `defaults`.
 *
 * `apiKey` is the resolved (decrypted) API key, or `undefined` for
 * providers that don't need one (local Ollama, etc.).
 */
export interface BuildChatModelInput {
  provider: ProviderConfig;
  entry: RegistryEntry;
  defaults: ChatDefaults;
  catalog: ModelCatalogService;
  apiKey: string | undefined;
  /** Optional per-call overrides (`maxTokens`, streaming forced off, …). */
  overrides?: BuildChatModelOverrides;
}

/**
 * Adapter dispatcher.
 *
 * Resolution rules:
 *   - `kind: "builtin" | "custom"`: dispatch via `provider.type`. The type
 *     discriminator drives the adapter; canonical built-ins use a fixed
 *     mapping (anthropic → anthropic adapter, etc.) and custom providers
 *     pick their type at add-time.
 *   - `kind: "system"`: rejected. System providers (opencode, copilot-plus)
 *     are credentialed by their agent backend and don't go through the
 *     BYOK chat path. Callers should never reach this method for them.
 *     Currently `copilot-plus` IS still used by the legacy chat path —
 *     the manager handles that case by injecting a fake `openai-compatible`
 *     provider shape, so it routes through that adapter.
 */
export class ChatModelFactory {
  /**
   * Build a `BaseChatModel` for the given provider + model + defaults.
   *
   * Throws if the provider type is unknown or if no adapter is registered.
   */
  static create(input: BuildChatModelInput): BaseChatModel {
    const adapterKey = resolveAdapterKey(input.provider);
    const adapter = ADAPTERS[adapterKey];
    if (!adapter) {
      throw new Error(
        `No chat-model adapter registered for provider id '${adapterKey}' ` +
          `(provider.id='${input.provider.id}', type='${input.provider.type ?? "none"}', ` +
          `kind='${input.provider.kind}')`
      );
    }
    if (!adapter.buildChatModel) {
      throw new Error(
        `Adapter for '${adapterKey}' does not implement buildChatModel(). ` +
          "Add a buildChatModel export to the adapter file."
      );
    }
    return adapter.buildChatModel(input);
  }
}

/**
 * Map a provider config to the adapter registry key (`ProviderId`).
 *
 * Built-in canonical providers store their id directly (e.g. `"openai"`),
 * which matches the adapter registry key. Custom providers store
 * `custom:<uuid>` ids — the adapter is selected by their `type` discriminator
 * (`"openai-compatible"`, `"anthropic"`, `"google"`, `"azure"`, `"bedrock"`,
 * `"github-copilot"`).
 *
 * System providers (`kind: "system"`) have no chat-model adapter; they're
 * handled by their agent backend instead.
 */
function resolveAdapterKey(provider: ProviderConfig): string {
  if (provider.kind === "system") {
    throw new Error(
      `Cannot build a chat model for system provider '${provider.id}'. ` +
        "System providers are handled by their agent backend, not the BYOK chat path."
    );
  }

  // Built-in providers: id IS the adapter key.
  if (provider.kind === "builtin") {
    return provider.id;
  }

  // Custom providers: dispatch by `type` discriminator.
  switch (provider.type) {
    case "openai-compatible":
      return "openai-compatible";
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "azure":
      return "azure";
    case "bedrock":
      return "amazon-bedrock";
    case "github-copilot":
      return "github-copilot";
    default:
      throw new Error(
        `Custom provider '${provider.id}' has no type discriminator; cannot resolve adapter.`
      );
  }
}
