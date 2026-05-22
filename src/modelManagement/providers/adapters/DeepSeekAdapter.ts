/**
 * DeepSeek adapter — uses the dedicated LangChain DeepSeek client.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatDeepSeek } from "@langchain/deepseek";
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders, ProviderInfo } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  buildProviderSpecificParams,
  resolveBaseUrl,
  resolveEnableCors,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";

export const extraSchema = z.object({}).strict();

/** No per-model overrides. */
export const entryExtraSchema = z.object({}).strict();

/** Build a DeepSeek LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { apiKey } = input;
  const enableCors = resolveEnableCors(input);
  const config = {
    ...buildBaseChatConfig(input),
    modelName: input.entry.modelId,
    apiKey,
    configuration: {
      baseURL: resolveBaseUrl(input) || ProviderInfo[ChatModelProviders.DEEPSEEK].host,
      fetch: enableCors ? safeFetch : undefined,
    },
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.DEEPSEEK, input.defaults),
  };
  return new ChatDeepSeek(config);
}
