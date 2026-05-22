/**
 * Single source of truth for the providers Copilot can instantiate via its
 * first-class LangChain adapters. The catalog filter, Add Provider dialog,
 * migration step, and (eventually) the eslint-enforced adapter registry all
 * reference this constant.
 *
 * To add a new provider:
 *   1. Add an adapter class under `src/modelManagement/providers/adapters/`.
 *   2. Add its canonical `models.dev` id to this array.
 *
 * IDs use the canonical `models.dev/api.json` shape (verified against the
 * live API). Notably: `xai` not `x-ai`, `amazon-bedrock` not `aws-bedrock`.
 *
 * Excluded from earlier drafts (no first-class LangChain adapter in this
 * plugin): `togetherai`, `fireworks-ai`, `perplexity`. Users who want them
 * can still configure them via the `openai-compatible` custom-provider path.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §1.2.
 */
export const SUPPORTED_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
  "xai",
  "deepseek",
  "openrouter",
  "cohere",
  "azure",
  "amazon-bedrock",
  "github-copilot",
  "ollama",
  "lmstudio",
  "siliconflow",
  "openai-compatible",
] as const;

/**
 * Union of the canonical provider ids Copilot natively supports.
 * Custom providers (user-added via Add Provider → Custom) use the
 * `custom:<uuid>` prefix and are NOT part of this union.
 */
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

/**
 * Convenience predicate. Useful in filter/migration code where we receive
 * arbitrary strings from `models.dev/api.json` or legacy settings.
 */
export function isSupportedProviderId(id: string): id is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(id);
}
