/**
 * Runtime types — produced by services / consumed by UI. Never written
 * to disk; never persisted in settings. Live alongside `catalog.ts`
 * and `persisted.ts` so the barrel can re-export everything from one
 * `types/` directory.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { ProviderType } from "./catalog";
import type { ConfiguredModel, Provider } from "./persisted";

/**
 * Outcome of a credential / endpoint check.
 *
 * Adapter-defined. Setup wizards surface `message` next to the API key
 * field on failure; pickers may surface `ok === true` as a "verified"
 * badge. `code` is optional machine-readable detail
 * ("invalid_api_key", "network", "rate_limited", …) — adapters use
 * whatever taxonomy fits.
 */
export interface VerificationResult {
  ok: boolean;
  /** Empty when `ok`; human-readable when not. */
  message?: string;
  /** Optional adapter-specific machine code. */
  code?: string;
  checkedAt: number;
}

/**
 * Result of `ModelCatalogService.refresh()`.
 *
 * On `ok: false` the in-memory catalog is unchanged — callers can keep
 * serving whatever was loaded before.
 */
export interface RefreshResult {
  ok: boolean;
  /** Which tier provided the data the service is currently serving. */
  source: "live" | "disk" | "memory";
  /** When the currently-served data was fetched. `null` before any
   *  successful load. */
  fetchedAt: number | null;
  /** Set when `ok: false`. */
  error?: string;
}

/**
 * Picker-ready view of a single entry in a backend's `enabledModels`.
 *
 * Resolved against the current `providers` + `configuredModels` state.
 * Broken refs (configured model deleted, provider deleted) surface as
 * `state: "broken"` so UI can show them with a ⚠ instead of silently
 * dropping — see data-model spec invariant #3.
 *
 * Discriminated union — narrowing on `state === "ok"` types
 * `configuredModel` and `provider` as required, so consumers don't
 * need to `!`-assert.
 */
export type EnabledBackendEntry =
  | {
      configuredModelId: string;
      state: "ok";
      configuredModel: ConfiguredModel;
      provider: Provider;
    }
  | {
      configuredModelId: string;
      state: "broken";
    };

/**
 * Output of `ChatModelFactory.build()` / `buildFor()`. Carries the
 * LangChain client plus the (provider, configuredModel) pair it was
 * built from, in case the caller needs to inspect those for logging
 * or telemetry.
 */
export interface BuiltChatModel {
  client: BaseChatModel;
  provider: Provider;
  configuredModel: ConfiguredModel;
}

/**
 * A built-in self-hosted provider template.
 *
 * Templates cover providers that `models.dev` does not (and never
 * will) list — local runners (Ollama, LMStudio), per-tenant deploys
 * (Azure, Bedrock), and the catch-all custom OpenAI-compatible
 * endpoint. Surfaced by `ModelCatalogService.listBuiltinTemplates()`
 * for the BYOK wizard's "Add provider" picker, next to the catalog
 * entries.
 *
 * Unlike `CatalogProvider`, a template carries no model list — the
 * user hand-types models, and the wizard creates `ConfiguredModel`
 * rows with just `id` + `displayName` populated.
 */
export interface ProviderTemplate {
  /** Template id ("ollama", "lmstudio", "custom-openai-compatible",
   *  "azure-openai", "aws-bedrock"). Not the resulting provider id —
   *  that gets minted at setup time. */
  id: string;
  displayName: string;
  /** Which adapter family the wizard will dispatch to. */
  providerType: ProviderType;
  /** Pre-fills the base URL field in the wizard. Omitted when the
   *  endpoint is per-user (custom proxy, Azure deployment URL, etc.). */
  defaultBaseUrl?: string;
  /** Hides the API-key field in the wizard when `false` (Ollama,
   *  LMStudio). */
  requiresApiKey: boolean;
  /** Placeholder shown in the wizard's "Add model" text input, since
   *  the user types model ids by hand. */
  modelInputHint: string;
}
