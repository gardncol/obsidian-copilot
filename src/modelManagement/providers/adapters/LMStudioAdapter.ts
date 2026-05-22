/**
 * LM Studio adapter — local OpenAI-compatible server. Uses the bespoke
 * `LMStudioChatModel` (Responses API) by default; users can opt out via
 * `legacyModel.useResponsesApi === false` and fall back to
 * `OpenRouterChatModel` (which is the same OpenAI-compatible shape with
 * reasoning extraction).
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  buildProviderSpecificParams,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { LMStudioChatModel } from "@/modelManagement/providers/clients/LMStudioChatModel";
import { OpenRouterChatModel } from "@/modelManagement/providers/clients/OpenRouterChatModel";
import { logInfo } from "@/logger";
import { safeFetch } from "@/utils";

export const extraSchema = z.object({}).strict();

/** Per-model override for LM Studio registry entries. */
export const entryExtraSchema = z
  .object({
    useResponsesApi: z.boolean().optional(),
  })
  .strict();

/** Build an LM Studio LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;
  const config = {
    ...buildBaseChatConfig(input),
    modelName: legacyModel.name,
    apiKey: apiKey || "default-key",
    streamUsage: legacyModel.streamUsage ?? false,
    configuration: {
      baseURL: legacyModel.baseUrl || "http://localhost:1234/v1",
      fetch: legacyModel.enableCors ? safeFetch : undefined,
    },
    // Pass reasoning hints unconditionally — the SDK ignores them for
    // non-reasoning models, and the previous capability gate added the risk
    // of mis-tagged custom models getting the wrong behavior.
    enableReasoning: true,
    reasoningEffort: legacyModel.reasoningEffort,
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.LM_STUDIO, legacyModel),
  };

  // Default to Responses-API-aware client for Responses API compatibility.
  // Opt out by setting `useResponsesApi` to false on the model. Read from
  // the per-model `entry.extra` first; fall back to the legacy `CustomModel`
  // field for in-memory lookups that still go through it.
  const rawUseResponsesApi = input.entry.extra?.useResponsesApi;
  const entryUseResponsesApi =
    typeof rawUseResponsesApi === "boolean" ? rawUseResponsesApi : undefined;
  const useResponsesApi = entryUseResponsesApi ?? legacyModel.useResponsesApi;
  if (useResponsesApi !== false) {
    logInfo(`[LMStudioAdapter] Using Responses API for LM Studio model: ${legacyModel.name}`);
    return new LMStudioChatModel(config);
  }
  return new OpenRouterChatModel(config);
}
