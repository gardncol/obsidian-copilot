/**
 * ChatModelManager — thin coordinator that selects the active chat model
 * and delegates LangChain client construction to `ChatModelFactory`. The
 * factory dispatches to per-provider adapters under
 * `src/modelManagement/providers/adapters/`, each of which owns its own
 * URL / header / Responses-API / fetch-implementation logic.
 *
 * **Credential resolution post-M9.** Provider credentials are read exclusively
 * from `settings.providers[id]` via `ProviderRegistry` — the legacy per-field
 * settings (`openAIApiKey`, `anthropicApiKey`, …) were deleted by the v0→v2
 * migration. Callers still pass `CustomModel` to `createModelInstance(model)`
 * / `setChatModel(model)` / `ping(model)`; we synthesize a `ProviderConfig`
 * + `RegistryEntry` for the factory and look up the key by the canonical
 * provider id derived from `customModel.provider`.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.4.
 */
import { CustomModel, getModelKey } from "@/aiParams";
import { BREVILABS_MODELS_BASE_URL, BUILTIN_CHAT_MODELS, ChatModelProviders } from "@/constants";
import { getDecryptedKey } from "@/encryptionService";
import { MissingApiKeyError, MissingPlusLicenseError } from "@/error";
import { logError, logInfo, logWarn } from "@/logger";
import { isPlusEnabled } from "@/plusUtils";
import {
  CopilotSettings,
  getModelKeyFromModel,
  getSettings,
  subscribeToSettingsChange,
} from "@/settings/model";
import { err2String, findCustomModel, safeFetch } from "@/utils";
import {
  isAnthropicThinkingModel,
  isOpenAIGPT5,
  isOpenAIOSeries,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { Notice } from "obsidian";

import {
  getProviderApiKeySync,
  ModelCatalogService,
  ModelRegistry,
  ProviderRegistry,
  type ProviderConfig,
  type RegistryEntry,
} from "@/modelManagement";
// ChatModelFactory and the AzureAdapter's normalize helper are imported
// from internal paths (carved out in eslint.config.mjs) to avoid pulling
// the entire adapter tree — and the LangChain packages it transitively
// depends on — into every caller of the @/modelManagement barrel.
import {
  ChatModelFactory,
  type BuildChatModelInput,
  type BuildChatModelOverrides,
} from "@/modelManagement/chatModel/ChatModelFactory";
import { normalizeAzureUrl as normalizeAzureUrlImpl } from "@/modelManagement/providers/adapters/AzureAdapter";

// Re-export `normalizeAzureUrl` so external callers (e.g. `utils/curlCommand.ts`)
// continue to import it from `@/LLMProviders/ChatModelManager` while the helper
// itself now lives with the Azure adapter.
export const normalizeAzureUrl = normalizeAzureUrlImpl;

// Patch BaseLanguageModel.prototype.getNumTokens once at module load to prevent
// tiktoken CDN fetches. LangChain's default getNumTokens() downloads a ~3MB BPE
// vocabulary from tiktoken.pages.dev, which blocks all LLM calls when the CDN is
// unreachable. This char/4 estimation is the same fallback LangChain uses internally
// before tiktoken loads. Actual token usage comes from API response metadata.
(
  BaseLanguageModel.prototype as { getNumTokens: (...args: unknown[]) => Promise<number> }
).getNumTokens = async (content: string | Array<{ type: string; text?: string }>) => {
  const text =
    typeof content === "string"
      ? content
      : content.map((item: { type: string; text?: string }): string => item.text ?? "").join("");
  return Math.ceil(text.length / 4);
};

/**
 * Map the legacy `ChatModelProviders` enum to the adapter registry key
 * (`ProviderId`). System providers (`COPILOT_PLUS`) are handled separately
 * by the manager and don't appear here.
 */
const LEGACY_PROVIDER_TO_ADAPTER_KEY: Record<string, string> = {
  [ChatModelProviders.OPENAI]: "openai",
  [ChatModelProviders.ANTHROPIC]: "anthropic",
  [ChatModelProviders.GOOGLE]: "google",
  [ChatModelProviders.XAI]: "xai",
  [ChatModelProviders.AZURE_OPENAI]: "azure",
  [ChatModelProviders.AMAZON_BEDROCK]: "amazon-bedrock",
  [ChatModelProviders.GROQ]: "groq",
  [ChatModelProviders.OLLAMA]: "ollama",
  [ChatModelProviders.LM_STUDIO]: "lmstudio",
  [ChatModelProviders.OPENROUTERAI]: "openrouter",
  [ChatModelProviders.MISTRAL]: "mistral",
  [ChatModelProviders.DEEPSEEK]: "deepseek",
  [ChatModelProviders.COHEREAI]: "cohere",
  [ChatModelProviders.SILICONFLOW]: "siliconflow",
  [ChatModelProviders.GITHUB_COPILOT]: "github-copilot",
  [ChatModelProviders.OPENAI_FORMAT]: "openai-compatible",
};

/**
 * Map an adapter key to the `ProviderConfig.type` discriminator. Used when
 * synthesizing a `ProviderConfig` from a legacy `CustomModel`.
 */
const ADAPTER_KEY_TO_PROVIDER_TYPE: Record<string, ProviderConfig["type"]> = {
  openai: "openai-compatible",
  "openai-compatible": "openai-compatible",
  cohere: "openai-compatible",
  mistral: "openai-compatible",
  deepseek: "openai-compatible",
  siliconflow: "openai-compatible",
  groq: "openai-compatible",
  xai: "openai-compatible",
  ollama: "openai-compatible",
  lmstudio: "openai-compatible",
  openrouter: "openai-compatible",
  "github-copilot": "github-copilot",
  anthropic: "anthropic",
  google: "google",
  azure: "azure",
  "amazon-bedrock": "bedrock",
};

/**
 * Per-instance manager for the active chat model + per-provider construction
 * logic. Holds the most recently configured `BaseChatModel` instance for the
 * scope that owns this manager (`getChatModel()`), and exposes per-call
 * factories (`createModelInstance(...)`, `ping(...)`).
 *
 * **No process-wide singleton state.** Each owning scope (chain, project chat,
 * agent backend) instantiates its own `ChatModelManager` so two scopes can
 * select different models simultaneously without contending on a shared slot.
 * A static `getInstance()` shim is retained for legacy callers that still
 * obtain a manager by name, but it returns a NEW instance on every call —
 * callers that want to share state must construct a single instance and pass
 * it to all collaborators.
 */
class ChatModelManager {
  private chatModel: BaseChatModel | null = null;
  private modelMap: Record<
    string,
    {
      hasApiKey: boolean;
      vendor: string;
    }
  > = {};

  /**
   * Resolve the default API key for a legacy `ChatModelProviders` value by
   * consulting `ProviderRegistry`. Local providers (Ollama / LM Studio /
   * OpenAI-format) have no stored credential; they get `"default-key"` so
   * the existing `hasApiKey` check (and downstream LangChain clients that
   * require a non-empty string) keep working. Copilot Plus and the GitHub
   * Copilot OAuth token slots remain on their dedicated settings fields —
   * neither is a BYOK credential.
   *
   * Returns `""` when no credential is configured.
   */
  private resolveDefaultApiKey(provider: ChatModelProviders): string {
    switch (provider) {
      case ChatModelProviders.OLLAMA:
      case ChatModelProviders.LM_STUDIO:
      case ChatModelProviders.OPENAI_FORMAT:
        return "default-key";
      case ChatModelProviders.COPILOT_PLUS:
        return getSettings().plusLicenseKey ?? "";
      case ChatModelProviders.GITHUB_COPILOT: {
        const settings = getSettings();
        return settings.githubCopilotToken || settings.githubCopilotAccessToken || "";
      }
      default: {
        const adapterKey = LEGACY_PROVIDER_TO_ADAPTER_KEY[provider];
        if (!adapterKey) return "";
        return getProviderApiKeySync(adapterKey) ?? "";
      }
    }
  }

  constructor() {
    this.buildModelMap();
    subscribeToSettingsChange(() => {
      this.buildModelMap();
      this.validateCurrentModel();
    });
  }

  /**
   * Legacy compatibility shim. Returns a NEW `ChatModelManager` on every call
   * — there is intentionally no shared singleton. Callers that want to share
   * state (e.g. the main chain manager and its chain runners) must construct
   * a single instance and pass it down. New code should prefer `new
   * ChatModelManager()` directly so the instance lifetime is explicit.
   */
  static getInstance(): ChatModelManager {
    return new ChatModelManager();
  }

  /**
   * Build a `BaseChatModel` by dispatching through `ChatModelFactory`.
   *
   * Resolves the active API key (decrypts as needed), looks up (or
   * synthesizes) a `ProviderConfig` / `RegistryEntry` from the `CustomModel`,
   * packages the global defaults, and forwards to the adapter for that
   * provider.
   *
   * `COPILOT_PLUS` is a system provider not in the BYOK adapter registry;
   * it's handled inline here as a fixed `ChatOpenAI` against the Brevilabs
   * proxy. All other providers go through the adapter dispatch path.
   */
  private async buildModelInstance(
    customModel: CustomModel,
    overrides?: BuildChatModelOverrides
  ): Promise<BaseChatModel> {
    const settings = getSettings();
    const provider = customModel.provider as ChatModelProviders;

    // Copilot Plus is a system-managed provider hitting the Brevilabs proxy.
    // It doesn't go through the BYOK adapter path (no `provider.type`); the
    // proxy itself enforces auth via the user's Plus license key.
    if (provider === ChatModelProviders.COPILOT_PLUS) {
      return buildCopilotPlusChatModel(customModel, settings, overrides);
    }

    const adapterKey = LEGACY_PROVIDER_TO_ADAPTER_KEY[provider];
    if (!adapterKey) {
      throw new Error(`Unknown provider: ${customModel.provider} for model: ${customModel.name}`);
    }

    const apiKey = await this.resolveApiKeyForLegacyModel(customModel);

    // Project-mode overrides for `temperature` / `maxTokens` flow in via the
    // `mergedModel = { ...customModel, ...project.modelConfigs }` shape that
    // `chainManager` constructs before calling `setChatModel`. Project
    // temperature/maxTokens are surfaced here as a per-call override on the
    // global defaults so adapters can stay registry-only.
    const resolvedTemperature = customModel.temperature ?? settings.temperature;
    const resolvedMaxTokens = customModel.maxTokens ?? settings.maxTokens;

    const input: BuildChatModelInput = {
      provider: resolveProviderConfig(customModel, adapterKey),
      entry: resolveRegistryEntry(customModel, adapterKey),
      defaults: {
        temperature: resolvedTemperature,
        maxTokens: resolvedMaxTokens,
        reasoningEffort: settings.reasoningEffort,
        verbosity: settings.verbosity,
        streaming: settings.stream,
      },
      catalog: ModelCatalogService.getInstance(),
      apiKey,
      overrides,
    };

    return ChatModelFactory.create(input);
  }

  /**
   * Resolve and decrypt the primary API key for a legacy `CustomModel`.
   *
   * Resolution order:
   *   1. Per-model override on `customModel.apiKey` (legacy, may carry an
   *      `enc_*` ciphertext on older installs).
   *   2. The provider's `apiKeyRef` via `ProviderRegistry` (post-M9 source
   *      of truth). Local-only providers fall through to `"default-key"`.
   *
   * Returns `undefined` when no credential can be resolved (the manager's
   * `hasApiKey` precheck and adapter-level guards surface a user-facing
   * error).
   */
  private async resolveApiKeyForLegacyModel(customModel: CustomModel): Promise<string | undefined> {
    const provider = customModel.provider as ChatModelProviders;
    const fallback = this.resolveDefaultApiKey(provider);
    const source = customModel.apiKey || fallback;
    if (!source) return undefined;
    return getDecryptedKey(source);
  }

  // Build a map of modelKey to model config
  public buildModelMap() {
    const activeModels = getSettings().activeModels;
    this.modelMap = {};
    const modelMap = this.modelMap;

    const allModels = activeModels ?? BUILTIN_CHAT_MODELS;

    allModels.forEach((model) => {
      if (model.enabled) {
        if (!Object.values(ChatModelProviders).contains(model.provider as ChatModelProviders)) {
          logWarn(`Unknown provider: ${model.provider} for model: ${model.name}`);
          return;
        }

        const hasCredentials = this.hasProviderCredentials(model);
        const modelKey = getModelKeyFromModel(model);
        modelMap[modelKey] = {
          hasApiKey: hasCredentials,
          vendor: model.provider,
        };
      }
    });
  }

  /**
   * Checks if a model has the necessary credentials configured for its provider.
   * @param model - The custom model definition.
   * @returns True when the provider requirements are satisfied, otherwise false.
   */
  private hasProviderCredentials(model: CustomModel): boolean {
    // Bedrock region defaults to us-east-1; only the API key is required.
    // Resolved via the same registry path as every other provider — no
    // special-case settings field anymore.
    const provider = model.provider as ChatModelProviders;
    return Boolean(model.apiKey || this.resolveDefaultApiKey(provider));
  }

  getChatModel(): BaseChatModel {
    if (!this.chatModel) {
      throw new Error("No valid chat model available. Please check your API key settings.");
    }
    return this.chatModel;
  }

  /**
   * Helper to validate a model config has valid credentials and meets entitlement requirements.
   * Does NOT check believerExclusive - that's validated at usage time, not selection time.
   */
  private isModelConfigValid(model: CustomModel, settings: CopilotSettings): boolean {
    const modelKey = getModelKeyFromModel(model);
    const modelInfo = this.modelMap[modelKey];

    // Check if model exists in map and has API key
    if (!modelInfo || !modelInfo.hasApiKey) {
      return false;
    }

    // Check Copilot Plus entitlement requirements (bypassed in self-host mode)
    if (model.plusExclusive && !isPlusEnabled()) {
      return false;
    }

    return true;
  }

  /**
   * Resolves the active chat model for temperature override operations.
   * Uses a single source of truth: getModelKey() -> findCustomModel()
   * Falls back to first valid model in settings.activeModels if current selection is invalid.
   *
   * Note: believerExclusive models are trusted if explicitly selected by the user,
   * but skipped in fallback to avoid selecting them for non-Believer users.
   */
  private resolveModelForTemperatureOverride(): CustomModel {
    const settings = getSettings();

    // Try to get the user's currently selected model
    try {
      const currentModelKey = getModelKey();
      if (currentModelKey) {
        const model = findCustomModel(currentModelKey, settings.activeModels);

        // Validate it (trust believerExclusive if user selected it)
        if (this.isModelConfigValid(model, settings)) {
          return model;
        }
      }
    } catch {
      // Model not found or invalid, fall through to fallback
    }

    // Fallback: Find first valid model in settings.activeModels
    // Skip believerExclusive models in fallback to avoid selecting them for non-Believer users
    for (const model of settings.activeModels) {
      if (model.enabled && !model.believerExclusive && this.isModelConfigValid(model, settings)) {
        return model;
      }
    }

    // No valid model found
    throw new Error(
      "No valid chat model available for temperature override. " +
        "Please check your API key settings and ensure at least one model is properly configured."
    );
  }

  /**
   * langchain 1.0 TypeScript doesn't support temperature override in BaseChatModelCallOptions,
   * so we need to create a new model instance with the specified temperature.
   */
  async getChatModelWithTemperature(temperature: number): Promise<BaseChatModel> {
    const modelConfig = this.resolveModelForTemperatureOverride();

    // Create a temporary model config with overridden temperature
    const modelWithTempOverride: CustomModel = {
      ...modelConfig,
      temperature,
    };

    return await this.createModelInstance(modelWithTempOverride);
  }

  async setChatModel(model: CustomModel): Promise<void> {
    try {
      const modelInstance = await this.createModelInstance(model);
      this.chatModel = modelInstance;

      // Log if Responses API is enabled for GPT-5
      if (
        isOpenAIGPT5(model.name) &&
        ((model.provider as ChatModelProviders) === ChatModelProviders.OPENAI ||
          (model.provider as ChatModelProviders) === ChatModelProviders.OPENAI_FORMAT)
      ) {
        logInfo(`Chat model set with Responses API for GPT-5: ${model.name}`);
      }
    } catch (error) {
      logError(error);
      throw error;
    }
  }

  async createModelInstance(model: CustomModel): Promise<BaseChatModel> {
    const modelKey = getModelKeyFromModel(model);
    const selectedModel = this.modelMap[modelKey];
    if (!selectedModel) {
      throw new Error(`No model found for: ${modelKey}`);
    }
    if (!selectedModel.hasApiKey) {
      const errorMessage = `API key is not provided for the model: ${modelKey}.`;
      if ((model.provider as ChatModelProviders) === ChatModelProviders.COPILOT_PLUS) {
        throw new MissingPlusLicenseError(
          "Copilot Plus license key is not configured. Please enter your license key in the Copilot Plus section at the top of Basic Settings."
        );
      }
      throw new MissingApiKeyError(errorMessage);
    }

    // All per-provider construction logic (Responses API routing, thinking
    // budgets, Bedrock endpoints, …) now lives in the adapter modules and
    // is dispatched through `ChatModelFactory.create()`.
    return this.buildModelInstance(model);
  }

  validateChatModel(chatModel: BaseChatModel): boolean {
    if (chatModel === undefined || chatModel === null) {
      return false;
    }
    return true;
  }

  // Custom token estimation function for fallback when model is unknown
  private estimateTokens(text: string): number {
    if (!text) return 0;
    // This is a simple approximation: ~4 chars per token for English text
    // More accurate than using word count, but still a decent estimation
    return Math.ceil(text.length / 4);
  }

  async countTokens(inputStr: string): Promise<number> {
    return this.chatModel?.getNumTokens(inputStr) ?? this.estimateTokens(inputStr);
  }

  private validateCurrentModel(): void {
    if (!this.chatModel) return;

    const currentModelKey = getModelKey();
    if (!currentModelKey) return;

    // Get the model configuration
    const selectedModel = this.modelMap[currentModelKey];

    // If API key is missing or model doesn't exist in map
    if (!selectedModel?.hasApiKey) {
      // Clear the current chat model
      this.chatModel = null;
      logInfo("Failed to reinitialize model due to missing API key");
    }
  }

  async ping(model: CustomModel): Promise<boolean> {
    const tryPing = async (enableCors: boolean) => {
      // For thinking-enabled models, maxTokens must be greater than
      // thinking.budget_tokens (2048). For other models, use a tiny budget
      // for a fast ping. Only Anthropic-family ids carry the thinking
      // config we'd need a larger budget for.
      const pingMaxTokens = isAnthropicThinkingModel(model.name) ? 4096 : 30;
      // Adapters own all per-provider construction; the factory wires the
      // ping-only overrides through `BuildChatModelInput.overrides`.
      const testModel = await this.buildModelInstance(model, {
        maxTokens: pingMaxTokens,
        forceNonStreaming: true,
        enableCors,
      });
      await testModel.invoke([{ role: "user", content: "hello" }], {
        timeout: 8000,
      });
    };

    try {
      // First try without CORS
      await tryPing(false);
      return true;
    } catch (firstError) {
      logInfo("First ping attempt failed, retrying with CORS enabled.");
      try {
        // Second try with CORS
        await tryPing(true);
        new Notice(
          "Connection successful, but requires CORS to be enabled. Please enable CORS for this model once you add it above."
        );
        return true;
      } catch (error) {
        const msg =
          "\nwithout CORS Error: " +
          err2String(firstError) +
          "\nwith CORS Error: " +
          err2String(error);
        throw new Error(msg);
      }
    }
  }
}

/**
 * Resolve the `ProviderConfig` for a legacy `CustomModel`.
 *
 * Prefers the real `ProviderConfig` stored under `settings.providers[adapterKey]`
 * so adapter-side reads of `provider.extra` (Azure deployment names, Bedrock
 * region, OpenAI org id, …) see the post-M9 source of truth. Falls back to a
 * shape synthesized from the `CustomModel` for providers the user has not
 * configured through the BYOK panel yet (e.g. local Ollama, OPENAI_FORMAT,
 * or the Copilot-Plus fake provider).
 */
function resolveProviderConfig(model: CustomModel, adapterKey: string): ProviderConfig {
  const stored = ProviderRegistry.getInstance().get(adapterKey);
  if (stored) return stored;

  // Synthesized fallback. Carry the OpenAI org id (legacy per-model field)
  // through `provider.extra.openAIOrgId` so the OpenAI adapter can read it
  // from its canonical post-M9 location.
  const extra: Record<string, unknown> = {};
  if (adapterKey === "openai" && model.openAIOrgId) {
    extra.openAIOrgId = model.openAIOrgId;
  }

  return {
    id: adapterKey,
    kind: "builtin",
    displayName: adapterKey,
    type: ADAPTER_KEY_TO_PROVIDER_TYPE[adapterKey],
    baseUrl: model.baseUrl,
    apiKeyRef: model.apiKey ? { kind: "inline", value: model.apiKey } : null,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    addedAt: 0,
  };
}

/**
 * Resolve the `RegistryEntry` for a legacy `CustomModel`.
 *
 * Prefers the real entry stored in `settings.registry` (so adapters see the
 * v0→v2 migration's `entry.extra` payload — `numCtx`, `useResponsesApi`,
 * `enablePromptCaching`, Azure deployment overrides, Bedrock region, etc.).
 * Falls back to a synthesized entry that hoists the relevant per-model fields
 * from the legacy `CustomModel` into `entry.extra` so the in-memory
 * `mergedModel` path (chainManager merges project overrides) keeps behaving
 * identically.
 */
function resolveRegistryEntry(model: CustomModel, adapterKey: string): RegistryEntry {
  const stored = ModelRegistry.getInstance().get(adapterKey, model.name);
  if (stored) return stored;

  const extra: Record<string, unknown> = {};
  if (typeof model.baseUrl === "string" && model.baseUrl.length > 0) {
    extra.baseUrl = model.baseUrl;
  }
  if (typeof model.enableCors === "boolean") {
    extra.enableCors = model.enableCors;
  }
  if (typeof model.numCtx === "number") {
    extra.numCtx = model.numCtx;
  }
  if (typeof model.useResponsesApi === "boolean") {
    extra.useResponsesApi = model.useResponsesApi;
  }
  if (typeof model.enablePromptCaching === "boolean") {
    extra.enablePromptCaching = model.enablePromptCaching;
  }
  if (typeof model.bedrockRegion === "string" && model.bedrockRegion.length > 0) {
    extra.bedrockRegion = model.bedrockRegion;
  }
  if (
    typeof model.azureOpenAIApiInstanceName === "string" &&
    model.azureOpenAIApiInstanceName.length > 0
  ) {
    extra.azureInstanceName = model.azureOpenAIApiInstanceName;
  }
  if (
    typeof model.azureOpenAIApiDeploymentName === "string" &&
    model.azureOpenAIApiDeploymentName.length > 0
  ) {
    extra.azureDeploymentName = model.azureOpenAIApiDeploymentName;
  }
  if (typeof model.azureOpenAIApiVersion === "string" && model.azureOpenAIApiVersion.length > 0) {
    extra.azureApiVersion = model.azureOpenAIApiVersion;
  }

  return {
    providerId: adapterKey,
    modelId: model.name,
    displayName: model.displayName || model.name,
    addedAt: 0,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/**
 * Build the Copilot Plus chat model — a `ChatOpenAI` wired against the
 * Brevilabs proxy. Plus is a system provider (no user-configured BYOK
 * surface) so it doesn't go through the adapter registry; the proxy
 * itself enforces auth via the user's Plus license key.
 */
async function buildCopilotPlusChatModel(
  customModel: CustomModel,
  settings: CopilotSettings,
  overrides: BuildChatModelOverrides | undefined
): Promise<BaseChatModel> {
  const maxTokens = overrides?.maxTokens ?? customModel.maxTokens ?? settings.maxTokens;
  const streaming = overrides?.forceNonStreaming ? false : (customModel.stream ?? true);
  // Match legacy: temperature is set only for non-thinking models. Copilot
  // Plus proxies both Anthropic and OpenAI ids, so check both families.
  const temperature = isAnthropicThinkingModel(customModel.name)
    ? undefined
    : isOpenAIOSeries(customModel.name) || isOpenAIGPT5(customModel.name)
      ? 1
      : (customModel.temperature ?? settings.temperature);

  const config: Record<string, unknown> = {
    modelName: customModel.name,
    apiKey: await getDecryptedKey(settings.plusLicenseKey),
    streaming,
    maxRetries: 3,
    maxConcurrency: 3,
    enableCors: customModel.enableCors,
    configuration: {
      baseURL: BREVILABS_MODELS_BASE_URL,
      fetch: safeFetch,
    },
    maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(customModel.topP !== undefined ? { topP: customModel.topP } : {}),
    ...(customModel.frequencyPenalty !== undefined
      ? { frequencyPenalty: customModel.frequencyPenalty }
      : {}),
  };

  return new ChatOpenAI(config);
}

// The class above is exported as `default` AND `ChatModelManager` (named).
// Legacy callers use `import ChatModelManager from "..."` (default form).
// The `@/modelManagement` barrel re-exports it as a named export.
export { ChatModelManager };
export default ChatModelManager;
