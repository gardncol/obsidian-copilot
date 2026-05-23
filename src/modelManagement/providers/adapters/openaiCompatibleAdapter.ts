/**
 * OpenAI-compatible adapter. Dispatch key:
 * `ProviderType === "openai-compatible"`.
 *
 * Covers the OpenAI SDK family — OpenAI proper, plus everything that
 * speaks the OpenAI Chat Completions wire format with a custom
 * `baseUrl`: Mistral, Groq, OpenRouter, Together, DeepSeek, xAI,
 * SiliconFlow, Ollama, LMStudio, and arbitrary custom proxies.
 *
 * The only optional extra is the OpenAI organization id, which a
 * subset of OpenAI accounts require. Everything else (base URL, API
 * key) lives on `Provider` directly.
 */

import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { VerificationResult } from "@/modelManagement/types/runtime";
import type { AdapterBuildContext, AdapterVerifyContext, ProviderAdapter } from "./ProviderAdapter";

const extrasSchema = z
  .object({
    /** OpenAI organization id (e.g. `org-…`). Only meaningful for
     *  OpenAI proper; ignored by other OpenAI-compatible endpoints. */
    openAIOrgId: z.string().optional(),
  })
  .strict();

type Extras = z.infer<typeof extrasSchema>;

export const openaiCompatibleAdapter: ProviderAdapter<Extras> = {
  providerType: "openai-compatible",
  extrasSchema,

  buildLangChainClient(ctx: AdapterBuildContext<Extras>): BaseChatModel {
    throw new Error(
      "[modelManagement] openaiCompatibleAdapter.buildLangChainClient not implemented yet"
    );
  },

  verifyCredentials(ctx: AdapterVerifyContext<Extras>): Promise<VerificationResult> {
    return Promise.resolve({
      ok: false,
      message: "not implemented",
      checkedAt: Date.now(),
    });
  },
};
