/**
 * OpenAI adapter — uses `ChatOpenAI` with full reasoning overlay
 * (o-series and GPT-5 effort + verbosity) and automatic Responses API
 * routing for GPT-5 models.
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
  resolveMaxTokens,
  resolveTemperature,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { logInfo } from "@/logger";
import { safeFetch } from "@/utils";

/** OpenAI accepts an optional org id alongside the API key. */
export const extraSchema = z
  .object({
    openAIOrgId: z.string().optional(),
  })
  .strict();

/** No per-model overrides for OpenAI. */
export const entryExtraSchema = z.object({}).strict();

/** Build an OpenAI LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey, extraSecrets } = input;
  const reasoningOverlay = buildOpenAIReasoningOverlay(legacyModel, { allowVerbosity: true });

  const config: Record<string, unknown> = {
    ...buildBaseChatConfig(input),
    modelName: legacyModel.name,
    apiKey,
    configuration: {
      baseURL: legacyModel.baseUrl,
      fetch: legacyModel.enableCors ? safeFetch : undefined,
      organization: extraSecrets?.openAIOrgId,
    },
    maxTokens: resolveMaxTokens(input),
    temperature: resolveTemperature(input),
    ...reasoningOverlay,
    ...buildProviderSpecificParams(ChatModelProviders.OPENAI, legacyModel),
  };

  // Match legacy: GPT-5 models route via Responses API for verbosity support.
  if (isOpenAIGPT5(legacyModel.name)) {
    config.useResponsesApi = true;
    logInfo(`Enabling Responses API for GPT-5 model: ${legacyModel.name} (openai)`);
  }

  return new ChatOpenAI(config);
}
