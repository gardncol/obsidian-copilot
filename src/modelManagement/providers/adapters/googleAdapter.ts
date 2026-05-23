/**
 * Google Generative AI adapter. Dispatch key:
 * `ProviderType === "google"`.
 *
 * Backs Gemini via `@langchain/google-genai`. No provider-level extras.
 */

import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { VerificationResult } from "@/modelManagement/types/runtime";
import type { AdapterBuildContext, AdapterVerifyContext, ProviderAdapter } from "./ProviderAdapter";

const extrasSchema = z.object({}).strict();

type Extras = z.infer<typeof extrasSchema>;

export const googleAdapter: ProviderAdapter<Extras> = {
  providerType: "google",
  extrasSchema,

  buildLangChainClient(ctx: AdapterBuildContext<Extras>): BaseChatModel {
    throw new Error("[modelManagement] googleAdapter.buildLangChainClient not implemented yet");
  },

  verifyCredentials(ctx: AdapterVerifyContext<Extras>): Promise<VerificationResult> {
    return Promise.resolve({
      ok: false,
      message: "not implemented",
      checkedAt: Date.now(),
    });
  },
};
