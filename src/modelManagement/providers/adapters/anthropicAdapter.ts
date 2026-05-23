/**
 * Anthropic adapter. Dispatch key: `ProviderType === "anthropic"`.
 *
 * Anthropic has no provider-level extras. `baseUrl` and `apiKey`
 * cover everything the SDK needs.
 *
 * Placeholder — `buildLangChainClient` throws; `verifyCredentials`
 * returns a non-ok result so setup wizards that probe on every
 * keystroke don't crash.
 */

import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { VerificationResult } from "@/modelManagement/types/runtime";
import type { AdapterBuildContext, AdapterVerifyContext, ProviderAdapter } from "./ProviderAdapter";

const extrasSchema = z.object({}).strict();

type Extras = z.infer<typeof extrasSchema>;

export const anthropicAdapter: ProviderAdapter<Extras> = {
  providerType: "anthropic",
  extrasSchema,

  buildLangChainClient(ctx: AdapterBuildContext<Extras>): BaseChatModel {
    throw new Error("[modelManagement] anthropicAdapter.buildLangChainClient not implemented yet");
  },

  verifyCredentials(ctx: AdapterVerifyContext<Extras>): Promise<VerificationResult> {
    return Promise.resolve({
      ok: false,
      message: "not implemented",
      checkedAt: Date.now(),
    });
  },
};
