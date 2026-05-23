/**
 * Source of truth for `BackendConfig` rows, keyed by `BackendType`.
 *
 * Wraps `settings.backends: Record<BackendType, BackendConfig>` (added
 * by the settings-wiring follow-up PR) with typed reads and
 * mutations. Resolves `enabledModels: configuredModelId[]` into
 * picker-ready entries via the joined `ConfiguredModelRegistry` +
 * `ProviderRegistry` state — see `resolveEnabled()`.
 *
 * Invariants enforced here:
 *   - `defaultModel`, if non-null, must be in `enabledModels` (#4).
 *   - Broken refs (`enabledModels[i]` not found in
 *     `configuredModels`) are surfaced as `state: "broken"`, never
 *     silently dropped (#3).
 *
 * React components consume reactive reads through
 * `state/atoms.ts`'s `backendPickerAtomFamily(backend)`. This class
 * is for mutations and non-React callers.
 */

import type { BackendConfig, BackendType } from "@/modelManagement/types/persisted";
import type { EnabledBackendEntry } from "@/modelManagement/types/runtime";
import type { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import type { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";

export class BackendConfigRegistry {
  /**
   * Constructor signature is final. Placeholder doesn't store deps;
   * implementer wires them when bodies land.
   */
  constructor(
    providerRegistry: ProviderRegistry,
    configuredModelRegistry: ConfiguredModelRegistry
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Returns a `BackendConfig` even when none is persisted yet —
   *  empty default `{ enabledModels: [], defaultModel: null }` so
   *  callers don't have to null-check. */
  get(backend: BackendType): BackendConfig {
    throw new Error("[modelManagement] BackendConfigRegistry.get not implemented yet");
  }

  /**
   * Resolve `enabledModels` (an array of `configuredModelId`s) into
   * picker-ready entries by joining against the current
   * ConfiguredModel + Provider state. Order preserved. Broken refs
   * surface as `state: "broken"`.
   */
  resolveEnabled(backend: BackendType): readonly EnabledBackendEntry[] {
    throw new Error("[modelManagement] BackendConfigRegistry.resolveEnabled not implemented yet");
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Replace the enabled-models list for a backend. The picker re-renders
   *  as a result (via `backendPickerAtomFamily`). */
  setEnabledModels(backend: BackendType, configuredModelIds: readonly string[]): Promise<void> {
    throw new Error("[modelManagement] BackendConfigRegistry.setEnabledModels not implemented yet");
  }

  /** Idempotent: appending an already-enabled id is a no-op. */
  enableModel(backend: BackendType, configuredModelId: string): Promise<void> {
    throw new Error("[modelManagement] BackendConfigRegistry.enableModel not implemented yet");
  }

  /** Idempotent. Clears `defaultModel` if it was the removed id. */
  disableModel(backend: BackendType, configuredModelId: string): Promise<void> {
    throw new Error("[modelManagement] BackendConfigRegistry.disableModel not implemented yet");
  }

  /**
   * Setting a non-null id that isn't in `enabledModels` throws
   * (invariant #4). Setting `null` clears the default.
   */
  setDefaultModel(backend: BackendType, configuredModelId: string | null): Promise<void> {
    throw new Error("[modelManagement] BackendConfigRegistry.setDefaultModel not implemented yet");
  }

  /**
   * Used by `ModelManagementCoordinator` to drop refs to deleted
   * configured models. Sweeps every backend's `enabledModels`;
   * updates `defaultModel` to `null` if it was one of the removed
   * ids.
   */
  removeRefs(configuredModelIds: readonly string[]): Promise<void> {
    throw new Error("[modelManagement] BackendConfigRegistry.removeRefs not implemented yet");
  }
}
