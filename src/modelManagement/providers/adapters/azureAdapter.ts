/**
 * Azure OpenAI adapter. Dispatch key: `ProviderType === "azure"`.
 *
 * Azure OpenAI requires three pieces of routing information beyond
 * the API key:
 *   - `azureInstanceName`   — the resource name in your Azure
 *                              subscription (e.g. `my-org-eastus`).
 *   - `azureDeploymentName` — the deployment id created in the Azure
 *                              portal. Wire model id flows through
 *                              the deployment, not directly to the
 *                              SDK.
 *   - `azureApiVersion`     — Azure pins clients to a dated API
 *                              version (e.g. `2024-08-01-preview`).
 *
 * All three are required; the schema rejects missing or empty values.
 */

import { z } from "zod";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { VerificationResult } from "@/modelManagement/types/runtime";
import type { AdapterBuildContext, AdapterVerifyContext, ProviderAdapter } from "./ProviderAdapter";

const extrasSchema = z
  .object({
    azureInstanceName: z.string().min(1),
    azureDeploymentName: z.string().min(1),
    azureApiVersion: z.string().min(1),
  })
  .strict();

type Extras = z.infer<typeof extrasSchema>;

export const azureAdapter: ProviderAdapter<Extras> = {
  providerType: "azure",
  extrasSchema,

  buildLangChainClient(ctx: AdapterBuildContext<Extras>): BaseChatModel {
    throw new Error("[modelManagement] azureAdapter.buildLangChainClient not implemented yet");
  },

  verifyCredentials(ctx: AdapterVerifyContext<Extras>): Promise<VerificationResult> {
    return Promise.resolve({
      ok: false,
      message: "not implemented",
      checkedAt: Date.now(),
    });
  },
};
