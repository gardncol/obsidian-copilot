import { ChatModelProviders, ChatModels, SettingKeyProviders } from "@/constants";
import { getProviderApiKeySync } from "@/modelManagement";
import { getSettings } from "@/settings/model";
import { CustomModel } from "@/aiParams";

/**
 * Map `SettingKeyProviders` (legacy `ChatModelProviders` enum string values)
 * to canonical `ProviderRegistry` provider ids. Copilot-Plus and GitHub
 * Copilot are handled inline below — neither is a BYOK credential.
 */
const SETTING_PROVIDER_TO_REGISTRY_ID: Partial<Record<SettingKeyProviders, string>> = {
  [ChatModelProviders.OPENAI]: "openai",
  [ChatModelProviders.ANTHROPIC]: "anthropic",
  [ChatModelProviders.AZURE_OPENAI]: "azure",
  [ChatModelProviders.GOOGLE]: "google",
  [ChatModelProviders.GROQ]: "groq",
  [ChatModelProviders.OPENROUTERAI]: "openrouter",
  [ChatModelProviders.COHEREAI]: "cohere",
  [ChatModelProviders.XAI]: "xai",
  [ChatModelProviders.MISTRAL]: "mistral",
  [ChatModelProviders.DEEPSEEK]: "deepseek",
  [ChatModelProviders.AMAZON_BEDROCK]: "amazon-bedrock",
  [ChatModelProviders.SILICONFLOW]: "siliconflow",
};

/**
 * Get API key for a provider, with model-specific key taking precedence over
 * `ProviderRegistry`. Post-M9 source of truth is `settings.providers[id]`;
 * Copilot-Plus and GitHub Copilot read from their dedicated settings fields.
 *
 * @param provider - The provider to get the API key for
 * @param model - Optional model instance; if provided and has apiKey, it will be used instead of the registry value
 * @returns The API key (model-specific if available, otherwise the registry value, or empty string)
 */
export function getApiKeyForProvider(provider: SettingKeyProviders, model?: CustomModel): string {
  if (model?.apiKey) return model.apiKey;
  if (provider === ChatModelProviders.COPILOT_PLUS) {
    return getSettings().plusLicenseKey ?? "";
  }
  if (provider === ChatModelProviders.GITHUB_COPILOT) {
    const settings = getSettings();
    return settings.githubCopilotToken || settings.githubCopilotAccessToken || "";
  }
  const registryId = SETTING_PROVIDER_TO_REGISTRY_ID[provider];
  if (!registryId) return "";
  return getProviderApiKeySync(registryId) ?? "";
}

/**
 * Get the list of models that are always required and cannot be disabled.
 * These models provide essential functionality for the plugin.
 * Uses a getter function to avoid circular dependency issues.
 */
function getRequiredModels(): ReadonlyArray<{ name: string; provider: string }> {
  return [
    { name: ChatModels.COPILOT_PLUS_FLASH, provider: ChatModelProviders.COPILOT_PLUS },
    { name: ChatModels.OPENROUTER_GEMINI_2_5_FLASH, provider: ChatModelProviders.OPENROUTERAI },
  ];
}

/**
 * Checks if a model is required and should always be enabled.
 * Required models cannot be disabled by users as they provide core plugin functionality.
 *
 * @param model - The model to check
 * @returns true if the model is required and must remain enabled, false otherwise
 *
 * @example
 * if (isRequiredChatModel(model)) {
 *   // This model cannot be disabled
 * }
 */
export function isRequiredChatModel(model: CustomModel): boolean {
  return getRequiredModels().some(
    (required) => required.name === model.name && required.provider === model.provider
  );
}
