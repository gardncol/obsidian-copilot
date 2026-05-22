/**
 * OpenRouter adapter — uses the local `OpenRouterChatModel` client (which
 * extends `ChatOpenAI` with reasoning-content extraction). Reasoning and
 * prompt caching are user-toggleable per model.
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
  resolveBaseUrl,
  resolveEnableCors,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { OpenRouterChatModel } from "@/modelManagement/providers/clients/OpenRouterChatModel";
import { safeFetch } from "@/utils";

export const extraSchema = z.object({}).strict();

/** Per-model override for OpenRouter registry entries. */
export const entryExtraSchema = z
  .object({
    enablePromptCaching: z.boolean().optional(),
  })
  .strict();

/** Build an OpenRouter LangChain chat model via `OpenRouterChatModel`. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { apiKey } = input;
  // Read prompt-caching toggle from `entry.extra`. Default to `true` when
  // unset so existing OpenRouter setups keep caching automatically.
  const rawEnablePromptCaching = input.entry.extra?.enablePromptCaching;
  const enablePromptCaching =
    typeof rawEnablePromptCaching === "boolean" ? rawEnablePromptCaching : true;
  const enableCors = resolveEnableCors(input);

  const config = {
    ...buildBaseChatConfig(input),
    modelName: input.entry.modelId,
    apiKey,
    configuration: {
      baseURL: resolveBaseUrl(input) || "https://openrouter.ai/api/v1",
      fetch: enableCors ? safeFetch : undefined,
      defaultHeaders: {
        "HTTP-Referer": "https://obsidiancopilot.com",
        "X-Title": "Obsidian Copilot",
      },
    },
    // Pass reasoning hints unconditionally — the SDK ignores them for
    // non-reasoning models, and the previous capability gate added the risk
    // of mis-tagged custom models getting the wrong behavior.
    enableReasoning: true,
    reasoningEffort: input.defaults.reasoningEffort,
    // Enable prompt caching by default; can be turned off for ZDR endpoints.
    enablePromptCaching,
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.OPENROUTERAI, input.defaults),
  };
  return new OpenRouterChatModel(config);
}
