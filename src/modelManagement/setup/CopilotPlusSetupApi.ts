/**
 * Copilot Plus setup workflow. Called by the Plus auth handler on
 * sign-in and sign-out. Persists exactly one `Provider` row with
 * `origin: { kind: "copilot-plus" }` and a `ConfiguredModel` per
 * Plus-hosted model.
 *
 * Plus is a singleton origin — there's at most one Plus provider at
 * any time. `registerPlusProvider` is idempotent: first call creates,
 * subsequent calls re-sync (rotate the API key, refresh model
 * metadata, diff the model list). Sign-out is
 * `unregisterPlusProvider`, which cascade-removes through
 * `ModelManagementCoordinator`.
 *
 * Default auto-enrollment mirrors BYOK: Plus models surface in both
 * Simple Chat and the OpenCode agent picker
 * (`BYOK_DEFAULT_AUTO_ENROLL`).
 */

import type { ModelManagementCoordinator } from "@/modelManagement/createModelManagement";
import type { ProviderType } from "@/modelManagement/types/catalog";
import type { BackendType } from "@/modelManagement/types/persisted";
import type { ModelInfo } from "@/modelManagement/types/catalog";
import type { BackendConfigRegistry } from "@/modelManagement/backends/BackendConfigRegistry";
import type { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import type { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";

export interface RegisterPlusProviderInput {
  /** Which adapter family backs the Plus relay (Plus may add more
   *  over time — Anthropic-flavoured, OpenAI-flavoured, etc.). */
  providerType: ProviderType;
  displayName: string;
  /** The Plus relay endpoint. */
  baseUrl: string;
  /** Plus-issued long-lived token. Rotated on each sign-in. */
  apiKey?: string;
  /** Authoritative list of currently-available Plus models. Existing
   *  ConfiguredModel rows under the Plus provider are diff-reconciled
   *  against this list (add new, update changed, remove gone). */
  models: readonly ModelInfo[];
  /** Defaults to `BYOK_DEFAULT_AUTO_ENROLL` (= chat + opencode). */
  autoEnrollIn?: readonly BackendType[];
}

export interface PlusSetupResult {
  providerId: string;
  configuredModelIds: string[];
}

export class CopilotPlusSetupApi {
  constructor(
    providerRegistry: ProviderRegistry,
    configuredModelRegistry: ConfiguredModelRegistry,
    backendConfigRegistry: BackendConfigRegistry,
    /** Required for the diff-reconcile + sign-out cascade: vanished
     *  Plus models and the Plus provider on sign-out are removed via
     *  `coordinator.removeConfiguredModel` /
     *  `coordinator.removeProvider`. */
    coordinator: ModelManagementCoordinator
  ) {}

  /**
   * Idempotent. First call creates a `Provider` row with
   * `origin: { kind: "copilot-plus" }` and ConfiguredModels for each
   * input model, then auto-enrolls them. Subsequent calls update the
   * Provider in place, rotate the API key, and diff-reconcile the
   * ConfiguredModel list.
   *
   * Newly-added ConfiguredModels are auto-enrolled into
   * `autoEnrollIn ?? BYOK_DEFAULT_AUTO_ENROLL`. Existing models that
   * are no longer in `input.models` are removed (cascading their
   * backend refs through the coordinator).
   */
  registerPlusProvider(input: RegisterPlusProviderInput): Promise<PlusSetupResult> {
    throw new Error(
      "[modelManagement] CopilotPlusSetupApi.registerPlusProvider not implemented yet"
    );
  }

  /**
   * Sign-out. Cascade-removes the (at most one) Plus provider,
   * dropping its ConfiguredModels and clearing backend refs. No-op
   * when no Plus provider exists.
   */
  unregisterPlusProvider(): Promise<void> {
    throw new Error(
      "[modelManagement] CopilotPlusSetupApi.unregisterPlusProvider not implemented yet"
    );
  }
}
