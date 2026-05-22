/**
 * Azure OpenAI adapter — uses `ChatOpenAI` with Azure-shaped URL routing
 * and the deployment-name as model id. The shared `normalizeAzureUrl`
 * helper handles the common "paste the full /chat/completions URL" case.
 *
 * Per §3.6, Azure carries instance/deployment/version in `ProviderConfig.extra`.
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
  resolveMaxTokens,
  resolveTemperature,
} from "@/modelManagement/providers/adapters/adapterUtils";
import { safeFetch } from "@/utils";

export const extraSchema = z
  .object({
    azureInstanceName: z.string().min(1),
    azureDeploymentName: z.string().min(1),
    azureApiVersion: z.string().min(1),
  })
  .strict();

/**
 * Per-model overrides for an Azure registry entry — each field overrides
 * the provider-level extra of the same name.
 */
export const entryExtraSchema = z
  .object({
    azureInstanceName: z.string().optional(),
    azureDeploymentName: z.string().optional(),
    azureApiVersion: z.string().optional(),
  })
  .strict();

/** Read a string field from `provider.extra`, returning undefined when absent/empty. */
function readExtra(input: BuildChatModelInput, key: string): string | undefined {
  const value = input.provider.extra?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a string field from `entry.extra`, returning undefined when absent/empty. */
function readEntryExtra(input: BuildChatModelInput, key: string): string | undefined {
  const value = input.entry.extra?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize an Azure URL that a user may have pasted in full. Strips
 * trailing `/chat/completions` or `/embeddings` and extracts `api-version`
 * from query parameters so the OpenAI client can construct the correct
 * final URL.
 */
export function normalizeAzureUrl(raw: string | undefined): {
  baseUrl: string | undefined;
  apiVersion: string | undefined;
} {
  if (!raw) return { baseUrl: undefined, apiVersion: undefined };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { baseUrl: raw, apiVersion: undefined };
  }

  const apiVersion = url.searchParams.get("api-version") || undefined;
  url.search = "";
  let baseUrl = url.toString().replace(/\/+$/, "");

  // Strip paths that the OpenAI client appends automatically.
  baseUrl = baseUrl.replace(/\/(chat\/completions|embeddings)$/, "");

  return { baseUrl, apiVersion };
}

/** Build an Azure OpenAI LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { legacyModel, apiKey } = input;
  // Azure deployment / instance / api-version live on `ProviderConfig.extra`
  // post-M9 (validated by `extraSchema` above). Per-model overrides may live
  // on `RegistryEntry.extra` (validated by `entryExtraSchema`); the legacy
  // `CustomModel` still wins when present during the transition.
  const entryInstance = readEntryExtra(input, "azureInstanceName");
  const entryDeployment = readEntryExtra(input, "azureDeploymentName");
  const entryApiVersion = readEntryExtra(input, "azureApiVersion");

  const extraInstance = readExtra(input, "azureInstanceName");
  const extraDeployment = readExtra(input, "azureDeploymentName");
  const extraApiVersion = readExtra(input, "azureApiVersion");
  const azureUrl = normalizeAzureUrl(legacyModel.baseUrl);
  const reasoningOverlay = buildOpenAIReasoningOverlay(legacyModel, { allowVerbosity: false });

  // Resolution order: per-model legacy field → per-model `entry.extra` →
  // provider-level `provider.extra`.
  const instanceName = legacyModel.azureOpenAIApiInstanceName || entryInstance || extraInstance;
  const deploymentName =
    legacyModel.azureOpenAIApiDeploymentName || entryDeployment || extraDeployment;
  const apiVersion = legacyModel.azureOpenAIApiVersion || entryApiVersion || extraApiVersion;

  const config = {
    ...buildBaseChatConfig(input),
    modelName: legacyModel.baseUrl ? legacyModel.name : deploymentName,
    apiKey,
    configuration: {
      baseURL:
        azureUrl.baseUrl ||
        `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
      defaultQuery: {
        "api-version": azureUrl.apiVersion || apiVersion || "2024-05-01-preview",
      },
      defaultHeaders: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      fetch: legacyModel.enableCors ? safeFetch : undefined,
    },
    maxTokens: resolveMaxTokens(input),
    temperature: resolveTemperature(input),
    ...reasoningOverlay,
    ...buildProviderSpecificParams(ChatModelProviders.AZURE_OPENAI, legacyModel),
  };
  return new ChatOpenAI(config);
}
