/**
 * Shared types for the model management module.
 *
 * These types are the public surface of `@/modelManagement` for the rest of
 * the codebase. Internal data shapes (catalog wire types, adapter-specific
 * `extra` schemas) live alongside their consumers.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §2.1.
 */

/**
 * Provider identifier.
 *
 * Built-in providers use canonical `models.dev` ids: `"anthropic"`,
 * `"openai"`, `"google"`, etc. (see `SUPPORTED_PROVIDER_IDS`).
 *
 * Custom providers (user-added via Add Provider → Custom) use the
 * `custom:<uuid>` prefix, e.g.
 * `"custom:550e8400-e29b-41d4-a716-446655440000"`.
 *
 * System-managed providers (`kind: "system"`) such as `"opencode"` and
 * `"copilot-plus"` are first-class entries in `settings.providers`. Auth is
 * inherent to the agent backend (no user-supplied API key), so they carry no
 * `apiKeyRef`. The BYOK UI filters them out — see `ProviderConfig.kind`.
 */
export type ProviderId = string;

/**
 * Where an API key actually lives.
 *
 * - `"keychain"`: stored in the OS keychain via `KeychainService`. `id` is
 *   the keychain entry id (vault-scoped).
 * - `"inline"`: stored as plain text inside `data.json`. Used only when
 *   keychain is unavailable (governed by the `_keychainOnly` setting).
 */
export type KeychainRef = { kind: "keychain"; id: string } | { kind: "inline"; value: string };

/**
 * Provider credentials and display config, persisted under
 * `settings.providers[providerId]`.
 */
export interface ProviderConfig {
  /** Canonical id or `custom:<uuid>`. Matches the map key. */
  id: ProviderId;
  /**
   * Provider classification.
   *
   * - `"builtin"`: canonical `models.dev` provider with a fixed `type`. User
   *   supplies an API key via the BYOK UI.
   * - `"custom"`: user-added via Add Provider → Custom. Free-form `baseUrl`
   *   + `type`. User supplies an API key (or null for local endpoints).
   * - `"system"`: pseudo-provider whose auth is inherent to the agent
   *   backend (e.g. `opencode` for opencode-bundled models, `copilot-plus`
   *   for Copilot Plus-hosted models). Has NO user-supplied `apiKeyRef` and
   *   NO `extras`; the agent backend is the source of credentials. The BYOK
   *   UI filters these out so they don't appear as user-configurable
   *   providers, but they DO live in `settings.providers` as first-class
   *   entries so the `RegistryEntry.providerId` FK invariant holds.
   */
  kind: "builtin" | "custom" | "system";
  /** User-visible label. For built-ins, defaults to the canonical name. */
  displayName: string;
  /**
   * Discriminator picked at add time. Drives which adapter handles requests
   * and what `extra` schema validates the opaque payload below.
   *
   * Optional for `kind: "system"` providers — they're handled by their
   * agent backend directly and don't go through the BYOK adapter layer.
   */
  type?: "openai-compatible" | "anthropic" | "google" | "azure" | "bedrock" | "github-copilot";
  /**
   * Optional base URL override. Always present for `kind: "custom"`. For
   * built-ins, present only when the user has overridden the default.
   */
  baseUrl?: string;
  /** `null` for providers that don't need a key (e.g. local Ollama). */
  apiKeyRef?: KeychainRef | null;
  /**
   * Opaque provider-specific payload. Validated by the adapter's Zod schema
   * at instantiation time (see §3.6) — keeps `ProviderConfig` stable while
   * letting adapters evolve their own shapes.
   *
   * Examples:
   *   - `azure`: `{ azureInstanceName, azureDeploymentName, azureApiVersion }`
   *   - `bedrock`: `{ bedrockRegion }`
   */
  extra?: Record<string, unknown>;
  /** Epoch millis when the provider was first added. */
  addedAt: number;
  /** Epoch millis of the last successful `verify()` call. */
  lastVerifiedAt?: number;
  /** Human-readable error from the last verify attempt, if any. */
  lastVerificationError?: string;
}

/**
 * One entry in the BYOK model registry, persisted under `settings.registry`.
 */
export interface RegistryEntry {
  /** Foreign key into `settings.providers`. */
  providerId: ProviderId;
  /** The model id as accepted by the provider's API (e.g.
   * `"claude-sonnet-4-5-20250929"`). */
  modelId: string;
  /** Human-readable label surfaced in pickers and dialogs. */
  displayName: string;
  /** Epoch millis when the model was added to the registry. */
  addedAt: number;
  /** Epoch millis of the last successful `verify()` call. */
  lastVerifiedAt?: number;
  /** Human-readable error from the last verify attempt, if any. */
  lastVerificationError?: string;
  /**
   * Opaque per-model overrides. Validated by the adapter's
   * `entryExtraSchema` at chat-model instantiation time. Examples:
   *  - `openai-compatible`: `{ baseUrl?, enableCors? }`
   *  - `azure`: `{ azureInstanceName?, azureDeploymentName?, azureApiVersion? }`
   *  - `amazon-bedrock`: `{ bedrockRegion? }`
   *  - `ollama`: `{ numCtx? }`
   *  - `lmstudio`: `{ useResponsesApi? }`
   *  - `openrouter`: `{ enablePromptCaching? }`
   *
   * Per-model knobs like `temperature` / `maxTokens` / `topP` / `reasoningEffort`
   * are NOT carried here — they live globally on `ChatDefaults` post-M9.
   */
  extra?: Record<string, unknown>;
}

/**
 * Result of `ProviderRegistry.verify(id)`. The provider classes raise on
 * malformed `extra`; we surface that error here rather than letting it
 * crash the dialog.
 */
export interface VerificationResult {
  ok: boolean;
  /** Human-readable error if `ok === false`. */
  error?: string;
  /** Epoch millis the verification call completed. */
  verifiedAt: number;
}

/**
 * Global chat defaults — user-editable in Chat settings and applied to
 * ALL chat invocations after the M9 redesign (per-model overrides have
 * been removed). Threaded into adapters via `BuildChatModelInput`.
 */
export interface ChatDefaults {
  temperature: number;
  maxTokens: number;
  reasoningEffort?: string;
  verbosity?: string;
  /** Streaming on/off. */
  streaming?: boolean;
}
