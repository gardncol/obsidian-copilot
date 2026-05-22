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
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";

export const extraSchema = z.object({}).strict();

/** No per-model overrides. */
export const entryExtraSchema = z.object({}).strict();

/** Build a DeepSeek LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;
  const config = {
    ...buildBaseChatConfig(input),
    modelName: legacyModel.name,
    apiKey,
    configuration: {
      baseURL: legacyModel.baseUrl || ProviderInfo[ChatModelProviders.DEEPSEEK].host,
      fetch: legacyModel.enableCors ? safeFetch : undefined,
    },
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.DEEPSEEK, legacyModel),
  };
  return new ChatDeepSeek(config);
}
