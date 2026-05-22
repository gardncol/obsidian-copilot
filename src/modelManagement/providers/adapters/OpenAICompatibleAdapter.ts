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
  const { legacyModel, apiKey } = input;
  const reasoningOverlay = buildOpenAIReasoningOverlay(legacyModel, { allowVerbosity: true });

  // Per-model overrides land on `RegistryEntry.extra` post-M9. Fall back to
  // the legacy `CustomModel` while in-memory chat-model lookups still flow
  // through it (see `chainManager.setChatModel(mergedModel)`). Read fields
  // directly — strict schema validation happens at write time (BYOK UI);
  // extra unknown keys preserved by the migration pass through harmlessly.
  const rawEntryExtra = input.entry.extra ?? {};
  const entryBaseUrl =
    typeof rawEntryExtra.baseUrl === "string" && rawEntryExtra.baseUrl.length > 0
      ? rawEntryExtra.baseUrl
      : undefined;
  const entryEnableCors =
    typeof rawEntryExtra.enableCors === "boolean" ? rawEntryExtra.enableCors : undefined;
  const baseUrl = entryBaseUrl ?? legacyModel.baseUrl;
  const enableCors = entryEnableCors ?? legacyModel.enableCors;

  const config: Record<string, unknown> = {
    ...buildBaseChatConfig(input),
    modelName: legacyModel.name,
    apiKey,
    streamUsage: legacyModel.streamUsage ?? false,
    configuration: {
      baseURL: baseUrl,
      fetch: enableCors ? safeFetch : undefined,
      defaultHeaders: { "dangerously-allow-browser": "true" },
    },
    maxTokens: resolveMaxTokens(input),
    temperature: resolveTemperature(input),
    ...reasoningOverlay,
    ...buildProviderSpecificParams(ChatModelProviders.OPENAI_FORMAT, legacyModel),
  };

  // Match legacy behavior: GPT-5 models automatically route via Responses API.
  if (isOpenAIGPT5(legacyModel.name)) {
    config.useResponsesApi = true;
    logInfo(`Enabling Responses API for GPT-5 model: ${legacyModel.name} (openai-compatible)`);
  }

  return new ChatOpenAI(config);
}
