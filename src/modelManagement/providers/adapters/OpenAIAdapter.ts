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
  resolveBaseUrl,
  resolveEnableCors,
  resolveMaxTokens,
  resolveTemperature,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { logInfo } from "@/logger";
import { safeFetch } from "@/utils";

/**
 * OpenAI accepts an optional organization id alongside the API key. Stored
 * on `ProviderConfig.extra.openAIOrgId` (populated by the v0→v2 migration
 * from the legacy top-level `settings.openAIOrgId` and editable via the
 * BYOK Configure Provider dialog).
 */
export const extraSchema = z
  .object({
    openAIOrgId: z.string().optional(),
  })
  .strict();

/** No per-model overrides for OpenAI. */
export const entryExtraSchema = z.object({}).strict();

/**
 * Read the OpenAI org id from `provider.extra` if present and non-empty.
 * Tolerates missing/typed-incorrectly values without throwing.
 */
function readOpenAIOrgId(input: BuildChatModelInput): string | undefined {
  const value = input.provider.extra?.openAIOrgId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Build an OpenAI LangChain chat model. */
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
    configuration: {
      baseURL: resolveBaseUrl(input),
      fetch: enableCors ? safeFetch : undefined,
      organization: readOpenAIOrgId(input),
    },
    maxTokens: resolveMaxTokens(input),
    temperature: resolveTemperature(input),
    ...reasoningOverlay,
    ...buildProviderSpecificParams(ChatModelProviders.OPENAI, input.defaults),
  };

  // Match legacy: GPT-5 models route via Responses API for verbosity support.
  if (isOpenAIGPT5(modelId)) {
    config.useResponsesApi = true;
    logInfo(`Enabling Responses API for GPT-5 model: ${modelId} (openai)`);
  }

  return new ChatOpenAI(config);
}
