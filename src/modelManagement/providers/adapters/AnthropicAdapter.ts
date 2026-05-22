/**
 * Anthropic adapter — uses the LangChain `ChatAnthropic` client. Forwards
 * the user's "thinking" preference for Claude reasoning models: 4.7+ ships
 * `adaptive` (no fixed budget) while pre-4.7 uses a fixed
 * `ANTHROPIC_THINKING_BUDGET_TOKENS` budget.
 *
 * Provider-specific id pattern matching (which Claude family supports
 * thinking, which minor version requires the adaptive shape) lives in
 * `adapterUtils.isAnthropicThinkingModel` /
 * `isAnthropicAdaptiveThinkingModel`. The catalog (`models.dev`) carries
 * a `reasoning: boolean` flag, but it's lazy-loaded and not always
 * available when the adapter runs synchronously, so the adapter trusts
 * its own provider-id knowledge.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  ANTHROPIC_THINKING_BUDGET_TOKENS,
  buildBaseChatConfig,
  buildProviderSpecificParams,
  isAnthropicAdaptiveThinkingModel,
  isAnthropicThinkingModel,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";

/** No provider-specific extras. */
export const extraSchema = z.object({}).strict();

/** No per-model overrides. */
export const entryExtraSchema = z.object({}).strict();

/** Build an Anthropic LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;

  const config: Record<string, unknown> = {
    ...buildBaseChatConfig(input),
    anthropicApiKey: apiKey,
    model: legacyModel.name,
    anthropicApiUrl: legacyModel.baseUrl,
    clientOptions: {
      // Required to bypass CORS restrictions in the renderer.
      defaultHeaders: {
        "anthropic-dangerous-direct-browser-access": "true",
      },
      fetch: legacyModel.enableCors ? safeFetch : undefined,
    },
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.ANTHROPIC, legacyModel),
  };

  if (isAnthropicThinkingModel(legacyModel.name)) {
    // Opus 4.7+ defaults `thinking.display` to "omitted" so thinking summaries
    // never reach the UI; force "summarized" for the adaptive branch. Pre-4.7
    // models default to "summarized" server-side and don't need this.
    config.thinking = isAnthropicAdaptiveThinkingModel(legacyModel.name)
      ? { type: "adaptive" as const, display: "summarized" as const }
      : {
          type: "enabled" as const,
          budget_tokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
        };
  }

  return new ChatAnthropic(config);
}
