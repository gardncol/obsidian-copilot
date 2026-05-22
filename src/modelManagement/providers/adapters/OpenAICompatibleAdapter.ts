/**
 * OpenAI-compatible adapter — generic OpenAI-API-shape endpoints.
 * Maps to the legacy `OPENAI_FORMAT` provider. Reasoning overlay is
 * applied identically to the OpenAI adapter (since most OpenAI-compatible
 * endpoints understand the same parameters).
 *
 * Custom providers default to this adapter when the user picks
 * "OpenAI-compatible" in the Add Provider dialog.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  buildOpenAIReasoningOverlay,
  buildProviderSpecificParams,
  isOpenAIGPT5,
  resolveBaseUrl,
  resolveEnableCors,
  resolveMaxTokens,
  resolveTemperature,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";
import { logInfo } from "@/logger";

export const extraSchema = z.object({}).strict();

/**
 * Per-model overrides for openai-compatible endpoints.
 *  - `baseUrl`: endpoint URL (overrides the provider-level baseUrl).
 *  - `enableCors`: route through Obsidian's `requestUrl` to bypass renderer
 *    CORS restrictions.
 */
export const entryExtraSchema = z
  .object({
    baseUrl: z.string().optional(),
    enableCors: z.boolean().optional(),
  })
  .strict();

/** Build an OpenAI-compatible LangChain chat model via `ChatOpenAI`. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { apiKey } = input;
  const modelId = input.entry.modelId;
  const enableCors = resolveEnableCors(input);
  const reasoningOverlay = buildOpenAIReasoningOverlay(modelId, input.defaults, {
    allowVerbosity: true,
  });

  const config: Record<string, unknown> = {
    ...buildBaseChatConfig(input),
    modelName: modelId,
    apiKey,
    streamUsage: input.defaults.streamUsage ?? false,
    configuration: {
      baseURL: resolveBaseUrl(input),
      fetch: enableCors ? safeFetch : undefined,
      defaultHeaders: { "dangerously-allow-browser": "true" },
    },
    maxTokens: resolveMaxTokens(input),
    temperature: resolveTemperature(input),
    ...reasoningOverlay,
    ...buildProviderSpecificParams(ChatModelProviders.OPENAI_FORMAT, input.defaults),
  };

  // Match legacy behavior: GPT-5 models automatically route via Responses API.
  if (isOpenAIGPT5(modelId)) {
    config.useResponsesApi = true;
    logInfo(`Enabling Responses API for GPT-5 model: ${modelId} (openai-compatible)`);
  }

  return new ChatOpenAI(config);
}
