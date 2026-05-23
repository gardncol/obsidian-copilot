/**
 * Source of truth for `Provider` rows.
 *
 * Wraps `settings.providers: Record<providerId, Provider>` (added by
 * the settings-wiring follow-up PR) with typed reads, mutations, and
 * keychain bridging. React components consume reactive reads through
 * the atoms in `state/atoms.ts`; this class is for mutations and for
 * non-React callers (the chat-model factory, the setup APIs, the
 * coordinator).
 *
 * Cascade semantics — `remove()` does NOT cascade to ConfiguredModels
 * or BackendConfigs on its own. Call `ModelManagementCoordinator.removeProvider`
 * from UI code; the coordinator orchestrates the cross-slice
 * removal. This method exists for the coordinator's use.
 */

import type { App } from "obsidian";

import type { ProviderType } from "@/modelManagement/types/catalog";
import type { Provider, ProviderOrigin } from "@/modelManagement/types/persisted";
import type { VerificationResult } from "@/modelManagement/types/runtime";
import type { ProviderAdapterRegistry } from "./adapters/ProviderAdapterRegistry";

export class ProviderRegistry {
  /**
   * Constructor signature is final. Placeholder doesn't store deps
   * because all method bodies throw; implementer adds private fields
   * (`#app`, `#adapters`) when the implementation lands.
   */
  constructor(app: App, adapters: ProviderAdapterRegistry) {}

  // -------------------------------------------------------------------------
  // Reads — synchronous, backed by `settings.providers`.
  // -------------------------------------------------------------------------

  /** All providers. Use the atoms in `state/atoms.ts` for reactive
   *  React reads; this method is for non-React callers. */
  list(): readonly Provider[] {
    throw new Error("[modelManagement] ProviderRegistry.list not implemented yet");
  }

  get(providerId: string): Provider | undefined {
    throw new Error("[modelManagement] ProviderRegistry.get not implemented yet");
  }

  /** Filter helper used by the BYOK tab (origin = "byok"), the agent
   *  setup flows (origin = "agent"), and the Plus sign-in handler
   *  (origin = "copilot-plus"). */
  listByOrigin(originKind: ProviderOrigin["kind"]): readonly Provider[] {
    throw new Error("[modelManagement] ProviderRegistry.listByOrigin not implemented yet");
  }

  /** Used by the agent-setup idempotency check (one
   *  `(agentType, providerType)` row at most). */
  listByProviderType(providerType: ProviderType): readonly Provider[] {
    throw new Error("[modelManagement] ProviderRegistry.listByProviderType not implemented yet");
  }

  // -------------------------------------------------------------------------
  // Mutations — persist via `updateSetting("providers", …)`.
  // -------------------------------------------------------------------------

  /**
   * Mints a fresh `providerId` (UUID), stamps `addedAt`, persists.
   * Returns the new `providerId`. Does NOT store the API key — callers
   * invoke `setApiKey(...)` separately so the keychain pointer is owned
   * by this registry. `apiKeyKeychainId` is excluded from the input
   * shape so callers cannot create a row whose pointer references a
   * keychain entry this code path never wrote.
   */
  add(input: Omit<Provider, "providerId" | "addedAt" | "apiKeyKeychainId">): Promise<string> {
    throw new Error("[modelManagement] ProviderRegistry.add not implemented yet");
  }

  /** Partial update. `providerId` and `addedAt` are immutable. */
  update(
    providerId: string,
    patch: Partial<Omit<Provider, "providerId" | "addedAt">>
  ): Promise<void> {
    throw new Error("[modelManagement] ProviderRegistry.update not implemented yet");
  }

  /**
   * Removes the row from `settings.providers` and clears its keychain
   * entry. Cross-slice cascade (ConfiguredModels + BackendConfig refs)
   * is the coordinator's job — see class docstring.
   */
  remove(providerId: string): Promise<void> {
    throw new Error("[modelManagement] ProviderRegistry.remove not implemented yet");
  }

  // -------------------------------------------------------------------------
  // Secrets — Obsidian keychain via `app.secretStorage` /
  // `KeychainService`.
  // -------------------------------------------------------------------------

  /** Reads the keychain entry referenced by the row's
   *  `apiKeyKeychainId`. Returns `null` for providers that don't take
   *  an API key (Ollama, LMStudio, agent-owned providers). */
  getApiKey(providerId: string): Promise<string | null> {
    throw new Error("[modelManagement] ProviderRegistry.getApiKey not implemented yet");
  }

  /** Generates a fresh `apiKeyKeychainId` if the provider doesn't
   *  yet have one; persists the row. Re-calling with a different key
   *  rotates in place (same keychain id, new value). */
  setApiKey(providerId: string, apiKey: string): Promise<void> {
    throw new Error("[modelManagement] ProviderRegistry.setApiKey not implemented yet");
  }

  /** Drops the keychain entry and clears `apiKeyKeychainId` on the row. */
  clearApiKey(providerId: string): Promise<void> {
    throw new Error("[modelManagement] ProviderRegistry.clearApiKey not implemented yet");
  }

  // -------------------------------------------------------------------------
  // Verification — dispatches to the adapter for `providerType`.
  // -------------------------------------------------------------------------

  /**
   * Issues an adapter-defined "ping". Returns the verification
   * result; does NOT persist it. Persistent
   * `lastVerifiedAt` / `lastVerificationError` fields are deferred
   * (see data-model spec §10).
   */
  verify(providerId: string): Promise<VerificationResult> {
    throw new Error("[modelManagement] ProviderRegistry.verify not implemented yet");
  }
}
