/**
 * GitHub Copilot adapter — chat-completions client by default. When the
 * model id is a Codex-family model or the user explicitly opts in, routes
 * to the Responses-API client. The Copilot OAuth token is injected by the
 * client itself; we only forward the optional fetch implementation here.
 *
 * GitHub Copilot uses OAuth tokens stored elsewhere on settings; the
 * `apiKeyRef` slot is unused. No extras.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  buildBaseChatConfig,
  resolveEnableCors,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { GitHubCopilotChatModel } from "@/LLMProviders/githubCopilot/GitHubCopilotChatModel";
import { GitHubCopilotResponsesModel } from "@/LLMProviders/githubCopilot/GitHubCopilotResponsesModel";
import { logInfo } from "@/logger";
import { safeFetchNoThrow, shouldUseGitHubCopilotResponsesApi } from "@/utils";

export const extraSchema = z.object({}).strict();

/** Per-model override for GitHub Copilot registry entries. */
export const entryExtraSchema = z
  .object({
    /**
     * Force the Responses API for this model. Codex-family ids opt in
     * automatically — this flag is for non-Codex models the user wants to
     * route through `/responses` regardless.
     */
    useResponsesApi: z.boolean().optional(),
  })
  .strict();

/** Build a GitHub Copilot LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const modelId = input.entry.modelId;
  const enableCors = resolveEnableCors(input);
  const rawUseResponsesApi = input.entry.extra?.useResponsesApi;
  const useResponsesApi = typeof rawUseResponsesApi === "boolean" ? rawUseResponsesApi : undefined;

  const config: Record<string, unknown> = {
    ...buildBaseChatConfig(input),
    modelName: modelId,
    // Use safeFetchNoThrow for CORS bypass on mobile platforms.
    // This doesn't throw on HTTP errors so 401 retry logic works correctly.
    // WARNING: AbortSignal/timeout will NOT work when enableCors is true
    // because Obsidian's requestUrl doesn't support cancellation.
    // Reason: fetchImplementation is passed to the authed fetch wrapper inside
    // GitHubCopilotChatModel, which injects Copilot token and headers per request.
    fetchImplementation: enableCors ? safeFetchNoThrow : undefined,
    maxTokens: resolveMaxTokens(input),
  };

  if (
    shouldUseGitHubCopilotResponsesApi({
      provider: ChatModelProviders.GITHUB_COPILOT,
      name: modelId,
      useResponsesApi,
    })
  ) {
    config.useResponsesApi = true;
    logInfo(`Enabling Responses API for GitHub Copilot model: ${modelId}`);
    return new GitHubCopilotResponsesModel(config);
  }

  return new GitHubCopilotChatModel(config);
}
