/**
 * Adapter registry — keyed by `ProviderId` (canonical models.dev id).
 *
 * **M9 status:** Adapters own per-provider chat-model construction end-to-end.
 * Each adapter file exports:
 *   - `extraSchema` (Zod) — validates `ProviderConfig.extra` (used by the
 *     Configure Provider dialog in M5).
 *   - `entryExtraSchema` (Zod) — validates `RegistryEntry.extra` (per-model
 *     overrides like `baseUrl`, Azure deployment overrides, Bedrock region,
 *     Ollama `numCtx`, LM Studio `useResponsesApi`, OpenRouter
 *     `enablePromptCaching`). Defaults to `z.object({}).strict()` for
 *     adapters with no per-model overrides.
 *   - `buildChatModel(input)` — instantiates the right LangChain
 *     `BaseChatModel` for this provider. The new `ChatModelFactory` dispatches
 *     to these; `ChatModelManager.getModelConfig` is now a thin wrapper.
 *
 * Add a new provider:
 *   1. Drop an adapter file alongside this one exposing the same shape.
 *   2. Register it in `ADAPTERS` below.
 *   3. Add its canonical id to `SUPPORTED_PROVIDER_IDS`.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import type { ProviderId } from "@/modelManagement/types";

import * as anthropicAdapter from "@/modelManagement/providers/adapters/AnthropicAdapter";
import * as openAIAdapter from "@/modelManagement/providers/adapters/OpenAIAdapter";
import * as googleAdapter from "@/modelManagement/providers/adapters/GoogleAdapter";
import * as azureAdapter from "@/modelManagement/providers/adapters/AzureAdapter";
import * as bedrockAdapter from "@/modelManagement/providers/adapters/BedrockAdapter";
import * as lmStudioAdapter from "@/modelManagement/providers/adapters/LMStudioAdapter";
import * as openRouterAdapter from "@/modelManagement/providers/adapters/OpenRouterAdapter";
import * as ollamaAdapter from "@/modelManagement/providers/adapters/OllamaAdapter";
import * as openAICompatibleAdapter from "@/modelManagement/providers/adapters/OpenAICompatibleAdapter";
import * as cohereAdapter from "@/modelManagement/providers/adapters/CohereAdapter";
import * as mistralAdapter from "@/modelManagement/providers/adapters/MistralAdapter";
import * as deepseekAdapter from "@/modelManagement/providers/adapters/DeepSeekAdapter";
import * as xaiAdapter from "@/modelManagement/providers/adapters/XAIAdapter";
import * as groqAdapter from "@/modelManagement/providers/adapters/GroqAdapter";
import * as siliconflowAdapter from "@/modelManagement/providers/adapters/SiliconFlowAdapter";
import * as githubCopilotAdapter from "@/modelManagement/providers/adapters/GitHubCopilotAdapter";

/**
 * Shape every adapter file must export. `buildChatModel` is the M9 hook
 * that `ChatModelFactory` dispatches to; `extraSchema` validates the
 * provider's opaque `extra` payload; `entryExtraSchema` validates the
 * per-model `RegistryEntry.extra` payload.
 */
export interface AdapterModule {
  /** Zod schema validating `ProviderConfig.extra` for this provider. */
  extraSchema: z.ZodSchema<Record<string, unknown>>;
  /**
   * Zod schema validating `RegistryEntry.extra` for this provider. Defaults
   * to `z.object({}).strict()` for adapters without per-model overrides.
   */
  entryExtraSchema: z.ZodSchema<Record<string, unknown>>;
  /**
   * Build a LangChain `BaseChatModel` for this provider. Adapters own
   * per-provider construction logic (Azure URL parsing, Bedrock endpoint
   * synthesis, Anthropic thinking budgets, OpenAI Responses API routing,
   * GitHub Copilot fetch wrapping, …). The factory is a pure dispatcher.
   */
  buildChatModel(input: BuildChatModelInput): BaseChatModel;
}

/**
 * Map of `ProviderId` → adapter module. Lookup is intentionally narrow —
 * unknown ids return `undefined` so callers can surface a clear error.
 */
export const ADAPTERS: Record<ProviderId, AdapterModule> = {
  anthropic: anthropicAdapter,
  openai: openAIAdapter,
  google: googleAdapter,
  azure: azureAdapter,
  "amazon-bedrock": bedrockAdapter,
  lmstudio: lmStudioAdapter,
  openrouter: openRouterAdapter,
  ollama: ollamaAdapter,
  "openai-compatible": openAICompatibleAdapter,
  cohere: cohereAdapter,
  mistral: mistralAdapter,
  deepseek: deepseekAdapter,
  xai: xaiAdapter,
  groq: groqAdapter,
  siliconflow: siliconflowAdapter,
  "github-copilot": githubCopilotAdapter,
};

/** Convenience accessor. Returns `undefined` for unknown providers. */
export function getAdapter(providerId: ProviderId): AdapterModule | undefined {
  return ADAPTERS[providerId];
}
