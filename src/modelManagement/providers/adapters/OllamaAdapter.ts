/**
 * Ollama adapter — local-first model server. Uses the `/api/chat` endpoint
 * (NOT `/v1`), passes `think: true` unconditionally (Ollama ignores it for
 * non-reasoning models), and routes through Obsidian's `requestUrl` when
 * CORS is enabled (required for mobile WebView calls to `http://` hosts).
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { ChatOllama } from "@langchain/ollama";
import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ChatModelProviders } from "@/constants";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";
import {
  DEFAULT_OLLAMA_NUM_CTX_VALUE,
  buildBaseChatConfig,
  buildProviderSpecificParams,
  resolveMaxTokens,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";

export const extraSchema = z.object({}).strict();

/** Per-model override for Ollama registry entries — `num_ctx` only. */
export const entryExtraSchema = z
  .object({
    numCtx: z.number().optional(),
  })
  .strict();

/** Build an Ollama LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;
  // `numCtx` can live on the registry entry post-M9; fall back to the
  // legacy `CustomModel` field, then the global default.
  const rawNumCtx = input.entry.extra?.numCtx;
  const entryNumCtx = typeof rawNumCtx === "number" ? rawNumCtx : undefined;
  const numCtx = entryNumCtx ?? legacyModel.numCtx ?? DEFAULT_OLLAMA_NUM_CTX_VALUE;

  const config = {
    ...buildBaseChatConfig(input),
    // ChatOllama uses `model` (not `modelName`).
    model: legacyModel.name,
    // MUST NOT include `/v1` in Ollama's baseUrl.
    baseUrl: legacyModel.baseUrl || "http://localhost:11434",
    headers: {
      Authorization: `Bearer ${apiKey || "default-key"}`,
    },
    // Route through `requestUrl` (safeFetch) to bypass CORS / mixed-content
    // restrictions — required on mobile (WKWebView) when calling http:// Ollama hosts.
    fetch: legacyModel.enableCors ? safeFetch : undefined,
    // Enable thinking unconditionally — Ollama ignores the flag for
    // non-reasoning models. Thinking content (e.g. qwen3, deepseek-r1) goes
    // to `additional_kwargs.reasoning_content`.
    think: true,
    // Reduce repetition in local models (1.1 = slight penalty, helps with hallucination loops).
    repeatPenalty: 1.1,
    numCtx,
    maxTokens: resolveMaxTokens(input),
    ...buildProviderSpecificParams(ChatModelProviders.OLLAMA, legacyModel),
  };
  return new ChatOllama(config);
}
