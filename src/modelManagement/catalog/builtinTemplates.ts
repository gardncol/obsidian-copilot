/**
 * Self-hosted / per-tenant provider templates.
 *
 * `models.dev` lists ~30 public providers (Anthropic, OpenAI, Google,
 * Mistral, …) but does not — and will never — list providers whose
 * configuration is per-user. Those are surfaced through this static
 * list and rendered next to the catalog entries in the BYOK
 * "Add provider" wizard.
 *
 * The shape (`ProviderTemplate`) carries no model list — the user
 * hand-types models, and the wizard creates `ConfiguredModel` rows
 * with just `id` + `displayName` populated. Wizards that want
 * pre-fetched model metadata use `CatalogProvider` from
 * `ModelCatalogService` instead.
 *
 * This is real data (not a stub) because UI components built against
 * the placeholder need a stable template list to render. Adding a
 * new template here is a one-line change — no other code path needs
 * to learn about it.
 */

import type { ProviderTemplate } from "@/modelManagement/types/runtime";

export const BUILTIN_PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: "ollama",
    displayName: "Ollama",
    providerType: "openai-compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    modelInputHint: "e.g. llama3.2, qwen2.5-coder:7b",
  },
  {
    id: "lmstudio",
    displayName: "LM Studio",
    providerType: "openai-compatible",
    defaultBaseUrl: "http://localhost:1234/v1",
    requiresApiKey: false,
    modelInputHint: "e.g. lmstudio-community/Qwen2.5-7B-Instruct-GGUF",
  },
  {
    id: "custom-openai-compatible",
    displayName: "Custom OpenAI-compatible",
    providerType: "openai-compatible",
    requiresApiKey: true,
    modelInputHint: "e.g. gpt-4o-mini",
  },
  {
    id: "azure-openai",
    displayName: "Azure OpenAI",
    providerType: "azure",
    requiresApiKey: true,
    modelInputHint: "matches your Azure deployment name",
  },
  {
    id: "aws-bedrock",
    displayName: "AWS Bedrock",
    providerType: "bedrock",
    requiresApiKey: true,
    modelInputHint: "e.g. anthropic.claude-sonnet-4-5",
  },
];
