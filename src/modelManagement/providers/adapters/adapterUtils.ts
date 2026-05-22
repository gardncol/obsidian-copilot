/**
 * Shared helpers used by `buildChatModel` implementations in the adapter
 * files. Each helper is a small pure function so adapters can mix and match
 * without duplicating the bookkeeping that the legacy
 * `ChatModelManager.getModelConfig` switch contained.
 *
 * NONE of these helpers reach for `getSettings()` or any singleton —
 * everything flows in via `BuildChatModelInput`. That keeps adapters
 * trivially unit-testable per the "avoid deep dependency chains" rule
 * in `AGENTS.md`.
 */
import { ChatModelProviders, DEFAULT_OLLAMA_NUM_CTX } from "@/constants";

import type { CustomModel } from "@/aiParams";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";

/**
 * OpenAI-family id pattern helpers.
 *
 * The "knowledge that `gpt-5*` ids exist" is provider-specific and lives in
 * the adapter layer rather than `src/utils.ts`. The helpers below are
 * consumed by `OpenAIAdapter`, `OpenAICompatibleAdapter`, `AzureAdapter`,
 * and the OpenAI-flavored helpers in this file.
 */

/** True iff the model id is an OpenAI GPT-5 family id (e.g. `gpt-5`, `gpt-5-mini`). */
export function isOpenAIGPT5(modelName: string): boolean {
  return modelName.startsWith("gpt-5");
}

/** True iff the model id is an OpenAI o-series reasoning id (`o1*`, `o3*`, `o4*`). */
export function isOpenAIOSeries(modelName: string): boolean {
  return modelName.startsWith("o1") || modelName.startsWith("o3") || modelName.startsWith("o4");
}

/**
 * Anthropic-family id pattern helpers.
 *
 * Anthropic doesn't expose a single capability flag in the model id; the
 * "thinking-enabled" set is hand-curated against the published model
 * families (3.7, Sonnet 4, Opus 4).
 */

/** True iff the Anthropic model id supports the `thinking` configuration. */
export function isAnthropicThinkingModel(modelName: string): boolean {
  return (
    modelName.startsWith("claude-3-7-sonnet") ||
    modelName.startsWith("claude-sonnet-4") ||
    modelName.startsWith("claude-opus-4")
  );
}

/**
 * True iff the Anthropic model id requires `{ type: "adaptive" }` thinking
 * rather than the legacy `{ type: "enabled", budget_tokens }` shape.
 *
 * Opus 4.7+ rejects the legacy shape with a 400. Detected by the minor
 * version on the opus-4 family. Constrained to 1-2 digits followed by a
 * delimiter or end-of-string so dated snapshot ids
 * (e.g. `claude-opus-4-20250514`) aren't misread as Opus 4.20250514.
 */
export function isAnthropicAdaptiveThinkingModel(modelName: string): boolean {
  const opusMinorMatch = modelName.match(/^claude-opus-4-(\d{1,2})(?:[-.]|$)/);
  return opusMinorMatch ? parseInt(opusMinorMatch[1], 10) >= 7 : false;
}

/**
 * Returns true when the model id is in a family whose responses include
 * server-side reasoning and therefore should omit the `temperature`
 * parameter on chat configuration. Matches the legacy `getModelInfo`
 * semantics (id pattern only, no provider gate) so Copilot Plus users
 * with Anthropic ids keep behaving like Anthropic direct.
 *
 * Reasoning toggles for the local providers (Ollama, LM Studio,
 * OpenRouter, Bedrock) are now passed unconditionally — the underlying
 * SDKs silently ignore the flag for non-reasoning models, which is
 * safer than gating on the user-declared REASONING capability (a
 * mis-tagged custom model would otherwise lose reasoning entirely).
 * Those adapters do not rely on this helper for `think` mode (only
 * for the temperature omission rule above).
 */
function isThinkingModel(legacyModel: CustomModel): boolean {
  return isAnthropicThinkingModel(legacyModel.name);
}

/**
 * True when the model is in an OpenAI reasoning family (o-series or GPT-5).
 * Matches the legacy `getModelInfo` semantics: id pattern only, no provider
 * gate. Used by OpenAI-family adapters to pin `temperature: 1`.
 */
function isOpenAIReasoningFamily(legacyModel: CustomModel): boolean {
  return isOpenAIOSeries(legacyModel.name) || isOpenAIGPT5(legacyModel.name);
}

/**
 * Temperature value forced for OpenAI reasoning families. The chat
 * completions endpoint rejects anything other than `1` for o-series /
 * GPT-5 models, so adapters that route through OpenAI's API must pin it.
 */
export const REASONING_MODEL_TEMPERATURE = 1;

/**
 * Adaptive thinking + budgeted-thinking budget for Anthropic models that
 * expose the `thinking` configuration. Pre-4.7 models use this number;
 * 4.7+ defaults to `adaptive` (no fixed budget).
 */
export const ANTHROPIC_THINKING_BUDGET_TOKENS = 2048;

/**
 * Returns the effective temperature for a model.
 *
 * - Thinking-enabled models: `undefined` (do not send `temperature`).
 * - OpenAI o-series / GPT-5: `1` (API rejects other values).
 * - Anything else: per-model override → global default.
 */
export function resolveTemperature(input: BuildChatModelInput): number | undefined {
  const { legacyModel, defaults } = input;

  if (isThinkingModel(legacyModel)) {
    return undefined;
  }
  if (isOpenAIReasoningFamily(legacyModel)) {
    return REASONING_MODEL_TEMPERATURE;
  }
  return legacyModel.temperature ?? defaults.temperature;
}

/**
 * Returns the effective max-output-tokens budget.
 *
 * - `overrides.maxTokens` (used by `ping`) wins absolutely.
 * - Otherwise: per-model override → global default.
 */
export function resolveMaxTokens(input: BuildChatModelInput): number {
  if (input.overrides?.maxTokens !== undefined) {
    return input.overrides.maxTokens;
  }
  return input.legacyModel.maxTokens ?? input.defaults.maxTokens;
}

/**
 * Returns the streaming flag.
 *
 * - `ping` forces non-streaming because it only calls `.invoke()`.
 * - Otherwise: per-model override → `true` (LangChain default).
 */
export function resolveStreaming(input: BuildChatModelInput): boolean {
  if (input.overrides?.forceNonStreaming) {
    return false;
  }
  return input.legacyModel.stream ?? true;
}

/**
 * Provider-specific parameter bag — only includes `topP` /
 * `frequencyPenalty` for providers whose LangChain client accepts them.
 * Mirrors the legacy `getProviderSpecificParams` exactly.
 */
export function buildProviderSpecificParams(
  provider: ChatModelProviders,
  legacyModel: CustomModel
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  const TOP_P_PROVIDERS = new Set<ChatModelProviders>([
    ChatModelProviders.OPENAI,
    ChatModelProviders.AZURE_OPENAI,
    ChatModelProviders.ANTHROPIC,
    ChatModelProviders.GOOGLE,
    ChatModelProviders.OPENROUTERAI,
    ChatModelProviders.OLLAMA,
    ChatModelProviders.LM_STUDIO,
    ChatModelProviders.OPENAI_FORMAT,
    ChatModelProviders.MISTRAL,
    ChatModelProviders.DEEPSEEK,
    ChatModelProviders.SILICONFLOW,
  ]);
  if (legacyModel.topP !== undefined && TOP_P_PROVIDERS.has(provider)) {
    params.topP = legacyModel.topP;
  }

  const FREQUENCY_PENALTY_PROVIDERS = new Set<ChatModelProviders>([
    ChatModelProviders.OPENAI,
    ChatModelProviders.AZURE_OPENAI,
    ChatModelProviders.OPENROUTERAI,
    ChatModelProviders.OLLAMA,
    ChatModelProviders.LM_STUDIO,
    ChatModelProviders.OPENAI_FORMAT,
    ChatModelProviders.MISTRAL,
    ChatModelProviders.DEEPSEEK,
    ChatModelProviders.SILICONFLOW,
  ]);
  if (legacyModel.frequencyPenalty !== undefined && FREQUENCY_PENALTY_PROVIDERS.has(provider)) {
    params.frequencyPenalty = legacyModel.frequencyPenalty;
  }

  return params;
}

/**
 * Builds the OpenAI-family "special config" overlay: reasoning effort
 * (o-series / GPT-5), verbosity (GPT-5 + Responses API only, NOT Azure).
 * Returns a config bag to spread alongside `maxTokens` / `temperature`.
 *
 * NOTE: `useResponsesApi` flag is added by the adapter, not here — it
 * depends on whether the adapter is the OpenAI adapter (true for GPT-5)
 * vs. Azure (always false). Mirrors legacy `getOpenAISpecialConfig`.
 */
export function buildOpenAIReasoningOverlay(
  legacyModel: CustomModel,
  options: { allowVerbosity: boolean }
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const modelName = legacyModel.name;
  const oSeries = isOpenAIOSeries(modelName);
  const gpt5 = isOpenAIGPT5(modelName);

  if ((oSeries || gpt5) && legacyModel.reasoningEffort) {
    config.reasoning = { effort: legacyModel.reasoningEffort };

    // Verbosity is GPT-5 + Responses API only. Azure does not support
    // Responses API so the adapter passes `allowVerbosity: false`.
    if (gpt5 && legacyModel.verbosity && options.allowVerbosity) {
      config.text = { verbosity: legacyModel.verbosity };
    }
  }

  return config;
}

/**
 * Returns the base shape every adapter starts from: `modelName`,
 * `streaming`, retry / concurrency knobs, and `enableCors`. Adapters
 * spread additional provider-specific fields on top.
 */
export function buildBaseChatConfig(input: BuildChatModelInput): Record<string, unknown> {
  const { legacyModel } = input;
  const temperature = resolveTemperature(input);
  const thinking = isThinkingModel(legacyModel);

  return {
    modelName: legacyModel.name,
    streaming: resolveStreaming(input),
    maxRetries: 3,
    maxConcurrency: 3,
    enableCors: legacyModel.enableCors,
    // Match legacy: only attach `temperature` for non-thinking models when
    // a value resolved. Provider-specific overlays may overwrite it.
    ...(!thinking && temperature !== undefined ? { temperature } : {}),
  };
}

/** Default Ollama `num_ctx` exported for adapters. */
export const DEFAULT_OLLAMA_NUM_CTX_VALUE = DEFAULT_OLLAMA_NUM_CTX;
