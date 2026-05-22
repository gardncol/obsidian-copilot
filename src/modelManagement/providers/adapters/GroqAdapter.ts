/**
 * Groq adapter — uses the dedicated LangChain Groq client.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatGroq } from "@langchain/groq";
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  buildProviderSpecificParams,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";

export const extraSchema = z.object({}).strict();

/** No per-model overrides. */
export const entryExtraSchema = z.object({}).strict();

/** Build a Groq LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { apiKey } = input;
  const config = {
    ...buildBaseChatConfig(input),
    apiKey,
    model: input.entry.modelId,
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.GROQ, input.defaults),
  };
  return new ChatGroq(config);
}
