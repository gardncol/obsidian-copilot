/**
 * Amazon Bedrock adapter — uses the local `BedrockChatModel` client.
 * Constructs the AWS endpoint from region (defaulting to us-east-1) or a
 * user-provided baseUrl. Extended thinking is enabled unconditionally for
 * the Anthropic path; the Bedrock SDK ignores the flag for non-thinking
 * models.
 *
 * Per §3.6, Bedrock carries its AWS region in `ProviderConfig.extra`.
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
  resolveStreaming,
  resolveTemperature,
} from "@/modelManagement/providers/adapters/adapterUtils";
import {
  BedrockChatModel,
  type BedrockChatModelFields,
} from "@/modelManagement/providers/clients/BedrockChatModel";
import { safeFetch } from "@/utils";

export const extraSchema = z
  .object({
    bedrockRegion: z.string().min(1).optional(),
  })
  .strict();

/** Per-model override for Bedrock registry entries — region only. */
export const entryExtraSchema = z
  .object({
    bedrockRegion: z.string().optional(),
  })
  .strict();

/** Build an Amazon Bedrock LangChain chat model. */
export function buildChatModel(input: BuildChatModelInput): BaseChatModel {
  const { apiKey } = input;

  if (!apiKey) {
    throw new Error(
      "Amazon Bedrock API key is not configured. Provide a key in Settings > API Keys or the model definition."
    );
  }

  // Bedrock region resolution order:
  //   1. `entry.extra.bedrockRegion` (per-model override on the registry entry).
  //   2. `provider.extra.bedrockRegion` (provider-level default).
  //   3. AWS default `us-east-1`.
  const rawEntryRegion = input.entry.extra?.bedrockRegion;
  const entryRegion = typeof rawEntryRegion === "string" ? rawEntryRegion.trim() : undefined;
  const rawExtraRegion = input.provider.extra?.bedrockRegion;
  const extraRegion = typeof rawExtraRegion === "string" ? rawExtraRegion.trim() : undefined;
  const resolvedRegion = entryRegion || extraRegion || "us-east-1";

  const baseUrlInput = resolveBaseUrl(input)?.trim();
  const baseUrl = baseUrlInput ? baseUrlInput.replace(/\/+$/, "") : undefined;
  const endpointBase = baseUrl || `https://bedrock-runtime.${resolvedRegion}.amazonaws.com`;

  const modelName = input.entry.modelId;
  const encodedModel = encodeURIComponent(modelName);
  const endpoint = `${endpointBase}/model/${encodedModel}/invoke`;
  const streamEndpoint = `${endpointBase}/model/${encodedModel}/invoke-with-response-stream`;
  const fetchImplementation = resolveEnableCors(input) ? safeFetch : undefined;

  // Inference profiles prefix Anthropic identifiers (e.g. global.anthropic.*),
  // so look for the segment anywhere — not just at the start.
  const requiresAnthropicVersion = /(^|\.)anthropic\./.test(modelName);
  const anthropicVersion = requiresAnthropicVersion ? "bedrock-2023-05-31" : undefined;
  // Always advertise thinking support for Anthropic-on-Bedrock; the Bedrock
  // SDK gates internally per-model, so dropping the capability check just
  // avoids mis-tagged custom models silently losing reasoning.
  const enableThinking = true;

  const maxTokens = resolveMaxTokens(input);
  const temperature = resolveTemperature(input);

  // Top-level fields the BedrockChatModel constructor expects.
  const bedrockFields: BedrockChatModelFields = {
    modelName,
    modelId: modelName,
    apiKey,
    endpoint,
    streamEndpoint,
    defaultMaxTokens: maxTokens,
    defaultTemperature: temperature,
    defaultTopP: input.defaults.topP,
    anthropicVersion,
    enableThinking,
    fetchImplementation,
    streaming: resolveStreaming(input),
  };

  // Merge with the base config so provider-specific params (topP/etc.) and
  // shared settings flow through identically to the legacy switch.
  const merged = {
    ...buildBaseChatConfig(input),
    ...bedrockFields,
    maxTokens,
    ...buildProviderSpecificParams(ChatModelProviders.AMAZON_BEDROCK, input.defaults),
  };
  return new BedrockChatModel(merged);
}
