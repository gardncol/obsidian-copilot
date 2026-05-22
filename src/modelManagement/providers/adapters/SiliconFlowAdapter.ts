/**
 * SiliconFlow adapter — OpenAI-compatible endpoint with the same
 * reasoning overlay treatment OpenAI gets.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders, ProviderInfo } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  buildOpenAIReasoningOverlay,
  buildProviderSpecificParams,
  resolveMaxTokens,
  resolveTemperature,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";

export const extraSchema = z.object({}).strict();

/** No per-model overrides. */
export const entryExtraSchema = z.object({}).strict();

/** Build a SiliconFlow LangChain chat model via the OpenAI-compatible client. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;
  const reasoningOverlay = buildOpenAIReasoningOverlay(legacyModel, { allowVerbosity: false });
  const config = {
    ...buildBaseChatConfig(input),
    modelName: legacyModel.name,
    apiKey,
    configuration: {
      baseURL: legacyModel.baseUrl || ProviderInfo[ChatModelProviders.SILICONFLOW].host,
      fetch: legacyModel.enableCors ? safeFetch : undefined,
    },
    // OpenAI special config always sets `maxTokens` / `temperature`;
    // replicate that so SiliconFlow behaves identically to legacy.
    maxTokens: resolveMaxTokens(input),
    temperature: resolveTemperature(input),
    ...reasoningOverlay,
    ...buildProviderSpecificParams(ChatModelProviders.SILICONFLOW, legacyModel),
  };
  return new ChatOpenAI(config);
}
