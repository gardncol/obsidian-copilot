/**
 * Google adapter — uses the LangChain Google Generative AI client with
 * safety filters disabled (matches legacy behavior).
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";

import type { SafetySetting } from "@google/generative-ai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  buildProviderSpecificParams,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";

/** No provider-specific extras. */
export const extraSchema = z.object({}).strict();

/** No per-model overrides. */
export const entryExtraSchema = z.object({}).strict();

const GOOGLE_SAFETY_SETTINGS_BLOCK_NONE: SafetySetting[] = [
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" } as SafetySetting,
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" } as SafetySetting,
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" } as SafetySetting,
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" } as SafetySetting,
];

/** Build a Google Generative AI LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;
  const config = {
    ...buildBaseChatConfig(input),
    apiKey,
    model: legacyModel.name,
    safetySettings: GOOGLE_SAFETY_SETTINGS_BLOCK_NONE,
    baseUrl: legacyModel.baseUrl,
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.GOOGLE, legacyModel),
  };
  return new ChatGoogleGenerativeAI(config);
}
