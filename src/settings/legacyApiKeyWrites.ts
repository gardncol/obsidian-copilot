/**
 * Legacy "Set Keys" dialog → BYOK provider bridge.
 *
 * The pre-M9 Basic Settings dialog (`ApiKeyDialog`) and the per-model
 * Add/Edit dialogs (`ModelAddDialog`, `ModelEditDialog`) used to write API
 * keys to `settings.openAIApiKey` / `settings.anthropicApiKey` / … directly.
 * After M9 those fields no longer exist; the BYOK panel is the source of
 * truth. This module routes those writes into `settings.providers[id]`
 * (creating a minimal `kind: "builtin"` `ProviderConfig` when needed) so
 * the legacy UI keeps working without divergence from the new shape.
 *
 * New code should call `ProviderRegistry` directly. This module exists to
 * keep the legacy entry points functional through the BYOK migration.
 */
import { ChatModelProviders, SettingKeyProviders } from "@/constants";
import { ProviderRegistry, type ProviderConfig } from "@/modelManagement";
import { getSettings, setSettings, updateSetting } from "@/settings/model";

/** Canonical adapter / provider id for each legacy `SettingKeyProviders`. */
const PROVIDER_TO_ID: Partial<Record<SettingKeyProviders, string>> = {
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

/** Map provider id → `ProviderConfig.type` discriminator + display name. */
const PROVIDER_META: Record<string, { type: ProviderConfig["type"]; displayName: string }> = {
  openai: { type: "openai-compatible", displayName: "OpenAI" },
  anthropic: { type: "anthropic", displayName: "Anthropic" },
  google: { type: "google", displayName: "Google" },
  azure: { type: "azure", displayName: "Azure OpenAI" },
  groq: { type: "openai-compatible", displayName: "Groq" },
  openrouter: { type: "openai-compatible", displayName: "OpenRouter" },
  cohere: { type: "openai-compatible", displayName: "Cohere" },
  xai: { type: "openai-compatible", displayName: "xAI" },
  mistral: { type: "openai-compatible", displayName: "Mistral" },
  deepseek: { type: "openai-compatible", displayName: "DeepSeek" },
  "amazon-bedrock": { type: "bedrock", displayName: "Amazon Bedrock" },
  siliconflow: { type: "openai-compatible", displayName: "SiliconFlow" },
};

/**
 * Persist a BYOK API key for a legacy `SettingKeyProviders` value. Creates
 * the provider entry if it doesn't exist yet; otherwise updates its
 * `apiKeyRef.value`.
 *
 * Copilot Plus license and GitHub Copilot OAuth tokens are handled inline —
 * they're not BYOK credentials and remain on their dedicated settings fields.
 */
export function writeLegacyApiKey(provider: SettingKeyProviders, value: string): void {
  if (provider === ChatModelProviders.COPILOT_PLUS) {
    updateSetting("plusLicenseKey", value);
    return;
  }
  if (provider === ChatModelProviders.GITHUB_COPILOT) {
    // GitHub Copilot uses OAuth; the dialog never lets the user paste a raw
    // token, but support the path defensively.
    updateSetting("githubCopilotToken", value);
    return;
  }
  const providerId = PROVIDER_TO_ID[provider];
  if (!providerId) return;
  const existing = ProviderRegistry.getInstance().get(providerId);
  setSettings((cur) => {
    const providers = { ...(cur.providers ?? {}) };
    if (existing) {
      providers[providerId] = {
        ...existing,
        apiKeyRef: value ? { kind: "inline", value } : null,
      };
    } else {
      const meta = PROVIDER_META[providerId];
      if (!meta) return cur;
      const next: ProviderConfig = {
        id: providerId,
        kind: "builtin",
        displayName: meta.displayName,
        type: meta.type,
        apiKeyRef: value ? { kind: "inline", value } : null,
        addedAt: Date.now(),
      };
      providers[providerId] = next;
    }
    return { providers };
  });
}

/**
 * Update a single `extra` field on a provider, creating the provider entry
 * if needed. Used by the legacy Azure / Bedrock / OpenAI dialogs that still
 * write extras (instance name, deployment, region, org id, …) one field at
 * a time. Pass `undefined` to clear the field.
 */
export function writeProviderExtra(
  providerId: string,
  field: string,
  value: string | undefined
): void {
  const existing = ProviderRegistry.getInstance().get(providerId);
  setSettings((cur) => {
    const providers = { ...(cur.providers ?? {}) };
    if (existing) {
      const nextExtra: Record<string, unknown> = { ...(existing.extra ?? {}) };
      if (value === undefined || value.length === 0) {
        delete nextExtra[field];
      } else {
        nextExtra[field] = value;
      }
      providers[providerId] = {
        ...existing,
        extra: Object.keys(nextExtra).length > 0 ? nextExtra : undefined,
      };
    } else {
      const meta = PROVIDER_META[providerId];
      if (!meta) return cur;
      const nextExtra: Record<string, unknown> = {};
      if (value !== undefined && value.length > 0) {
        nextExtra[field] = value;
      }
      const next: ProviderConfig = {
        id: providerId,
        kind: "builtin",
        displayName: meta.displayName,
        type: meta.type,
        apiKeyRef: null,
        ...(Object.keys(nextExtra).length > 0 ? { extra: nextExtra } : {}),
        addedAt: Date.now(),
      };
      providers[providerId] = next;
    }
    return { providers };
  });
}

/**
 * Read a single `extra` field from a provider. Returns `""` when absent so
 * legacy form components can use it as a controlled-input value.
 */
export function readProviderExtra(providerId: string, field: string): string {
  const provider = getSettings().providers?.[providerId];
  const value = provider?.extra?.[field];
  return typeof value === "string" ? value : "";
}
