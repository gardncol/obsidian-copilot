/**
 * Source of truth for `BackendConfig` rows, keyed by `BackendType`.
 *
 * Wraps `settings.backends: Partial<Record<BackendType, BackendConfig>>`
 * with typed reads and mutations. Resolves `enabledModels:
 * configuredModelId[]` into picker-ready entries via the joined
 * `ConfiguredModelRegistry` + `ProviderRegistry` state — see
 * `resolveEnabled()`.
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

import { getSettings, setSettings } from "@/settings/model";

import type { BackendConfig, BackendType } from "@/modelManagement/types/persisted";
import type { EnabledBackendEntry } from "@/modelManagement/types/runtime";
import type { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import type { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";

// Shared frozen empty so `get()` returns a stable reference for backends
// that haven't been touched yet — Jotai derived atoms and React memos
// short-circuit on `===`. See AGENTS.md → "Referential stability".
const EMPTY_ENABLED: string[] = Object.freeze([]) as unknown as string[];
const EMPTY_CONFIG: BackendConfig = Object.freeze({
  enabledModels: EMPTY_ENABLED,
  defaultModel: null,
});

const EMPTY_RESOLVED: readonly EnabledBackendEntry[] = Object.freeze([]);

export class BackendConfigRegistry {
  readonly #providers: ProviderRegistry;
  readonly #models: ConfiguredModelRegistry;

  constructor(
    providerRegistry: ProviderRegistry,
    configuredModelRegistry: ConfiguredModelRegistry
  ) {
    this.#providers = providerRegistry;
    this.#models = configuredModelRegistry;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Returns a `BackendConfig` even when none is persisted yet —
   *  empty default `{ enabledModels: [], defaultModel: null }` so
   *  callers don't have to null-check. The same `EMPTY_CONFIG`
   *  reference is returned for every untouched backend (referential
   *  stability). */
  get(backend: BackendType): BackendConfig {
    return getSettings().backends[backend] ?? EMPTY_CONFIG;
  }

  /**
   * Resolve `enabledModels` (an array of `configuredModelId`s) into
   * picker-ready entries by joining against the current
   * ConfiguredModel + Provider state. Order preserved. Broken refs
   * surface as `state: "broken"` rather than silently dropping (data-
   * model spec invariant #3).
   */
  resolveEnabled(backend: BackendType): readonly EnabledBackendEntry[] {
    const config = this.get(backend);
    if (config.enabledModels.length === 0) return EMPTY_RESOLVED;
    return config.enabledModels.map((configuredModelId): EnabledBackendEntry => {
      const configuredModel = this.#models.get(configuredModelId);
      const provider = configuredModel
        ? this.#providers.get(configuredModel.providerId)
        : undefined;
      if (configuredModel && provider) {
        return { configuredModelId, state: "ok", configuredModel, provider };
      }
      return { configuredModelId, state: "broken" };
    });
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Replace the enabled-models list for a backend. Clears
   * `defaultModel` if it pointed at an id that's no longer in the
   * list (invariant #4).
   */
  async setEnabledModels(
    backend: BackendType,
    configuredModelIds: readonly string[]
  ): Promise<void> {
    setSettings((cur) => {
      const existing = cur.backends[backend];
      const nextIds = [...configuredModelIds];
      const defaultModel =
        existing?.defaultModel && nextIds.includes(existing.defaultModel)
          ? existing.defaultModel
          : null;
      const next: BackendConfig = { enabledModels: nextIds, defaultModel };
      return { backends: { ...cur.backends, [backend]: next } };
    });
  }

  /** Idempotent: appending an already-enabled id is a no-op. */
  async enableModel(backend: BackendType, configuredModelId: string): Promise<void> {
    const existing = getSettings().backends[backend];
    if (existing?.enabledModels.includes(configuredModelId)) return;
    setSettings((cur) => {
      const current = cur.backends[backend];
      // Re-check inside the updater so a concurrent write that already
      // added the id doesn't produce a duplicate row.
      if (current?.enabledModels.includes(configuredModelId)) return {};
      const next: BackendConfig = {
        enabledModels: [...(current?.enabledModels ?? []), configuredModelId],
        defaultModel: current?.defaultModel ?? null,
      };
      return { backends: { ...cur.backends, [backend]: next } };
    });
  }

  /** Idempotent. Clears `defaultModel` if it was the removed id. */
  async disableModel(backend: BackendType, configuredModelId: string): Promise<void> {
    const existing = getSettings().backends[backend];
    if (!existing || !existing.enabledModels.includes(configuredModelId)) return;
    setSettings((cur) => {
      const current = cur.backends[backend];
      if (!current) return {};
      const nextIds = current.enabledModels.filter((id) => id !== configuredModelId);
      const next: BackendConfig = {
        enabledModels: nextIds,
        defaultModel:
          current.defaultModel === configuredModelId ? null : (current.defaultModel ?? null),
      };
      return { backends: { ...cur.backends, [backend]: next } };
    });
  }

  /**
   * Setting a non-null id that isn't in `enabledModels` throws
   * (invariant #4). Setting `null` clears the default.
   */
  async setDefaultModel(backend: BackendType, configuredModelId: string | null): Promise<void> {
    if (configuredModelId !== null) {
      const existing = getSettings().backends[backend];
      if (!existing || !existing.enabledModels.includes(configuredModelId)) {
        throw new Error(
          `[modelManagement] BackendConfigRegistry.setDefaultModel: ` +
            `id ${configuredModelId} is not in ${backend}.enabledModels (invariant #4)`
        );
      }
    }
    setSettings((cur) => {
      const current = cur.backends[backend];
      // Clearing the default on a backend that has no config row is a
      // no-op — avoid creating a spurious empty BackendConfig entry.
      if (!current && configuredModelId === null) return {};
      const base = current ?? { enabledModels: [], defaultModel: null };
      const next: BackendConfig = {
        enabledModels: [...base.enabledModels],
        defaultModel: configuredModelId,
      };
      return { backends: { ...cur.backends, [backend]: next } };
    });
  }

  /**
   * Used by `ModelManagementCoordinator` to drop refs to deleted
   * configured models. Sweeps every backend's `enabledModels`;
   * updates `defaultModel` to `null` if it was one of the removed
   * ids. Single `setSettings` write so subscribers only see one
   * settings revision per cascade.
   */
  async removeRefs(configuredModelIds: readonly string[]): Promise<void> {
    if (configuredModelIds.length === 0) return;
    const removed = new Set(configuredModelIds);
    setSettings((cur) => {
      let mutated = false;
      const nextBackends: Partial<Record<BackendType, BackendConfig>> = { ...cur.backends };
      for (const [backendKey, config] of Object.entries(cur.backends) as Array<
        [BackendType, BackendConfig]
      >) {
        const touchesEnabled = config.enabledModels.some((id) => removed.has(id));
        const touchesDefault = config.defaultModel != null && removed.has(config.defaultModel);
        if (!touchesEnabled && !touchesDefault) continue;
        nextBackends[backendKey] = {
          enabledModels: config.enabledModels.filter((id) => !removed.has(id)),
          defaultModel: touchesDefault ? null : (config.defaultModel ?? null),
        };
        mutated = true;
      }
      return mutated ? { backends: nextBackends } : {};
    });
  }
}
