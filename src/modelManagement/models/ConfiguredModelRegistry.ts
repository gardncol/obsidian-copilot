/**
 * Source of truth for `ConfiguredModel` rows.
 *
 * Wraps `settings.configuredModels: ConfiguredModel[]` (added by the
 * settings-wiring follow-up PR) with typed reads and mutations.
 * Uniqueness invariant: `(providerId, info.id)` — enforced on `add()`
 * and `bulkSet()` writes.
 *
 * React components consume reactive reads through the atoms in
 * `state/atoms.ts`. This class is for mutations and non-React callers.
 */

import type { ConfiguredModel } from "@/modelManagement/types/persisted";

export class ConfiguredModelRegistry {
  /**
   * No constructor args — `settings.configuredModels` is read/written
   * through the module-level helpers in `@/settings/model`, not
   * through Obsidian APIs.
   */
  constructor() {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(): readonly ConfiguredModel[] {
    throw new Error("[modelManagement] ConfiguredModelRegistry.list not implemented yet");
  }

  listByProvider(providerId: string): readonly ConfiguredModel[] {
    throw new Error("[modelManagement] ConfiguredModelRegistry.listByProvider not implemented yet");
  }

  get(configuredModelId: string): ConfiguredModel | undefined {
    throw new Error("[modelManagement] ConfiguredModelRegistry.get not implemented yet");
  }

  /** Resolve by the wire-form id under a specific provider. Used when
   *  reconciling external references — e.g. an agent picker rehydrating
   *  `<providerId>/<wireId>` strings into rows. */
  getByWireId(providerId: string, wireModelId: string): ConfiguredModel | undefined {
    throw new Error("[modelManagement] ConfiguredModelRegistry.getByWireId not implemented yet");
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Mints `configuredModelId`, stamps `configuredAt`. Throws if the
   *  `(providerId, info.id)` pair already exists. */
  add(input: Omit<ConfiguredModel, "configuredModelId" | "configuredAt">): Promise<string> {
    throw new Error("[modelManagement] ConfiguredModelRegistry.add not implemented yet");
  }

  /** Patches `info` only — id / providerId / configuredAt are
   *  immutable. Used by `CopilotPlusSetupApi` to refresh model
   *  metadata when Plus updates context limits / pricing. */
  update(
    configuredModelId: string,
    patch: { info?: Partial<ConfiguredModel["info"]> }
  ): Promise<void> {
    throw new Error("[modelManagement] ConfiguredModelRegistry.update not implemented yet");
  }

  remove(configuredModelId: string): Promise<void> {
    throw new Error("[modelManagement] ConfiguredModelRegistry.remove not implemented yet");
  }

  /**
   * Replace the set of configured models under one provider in a
   * single write. Used by "Configure Provider → save" where the user
   * picked N catalog models at once. Existing rows with matching
   * `(providerId, info.id)` are preserved by id so downstream
   * `BackendConfig.enabledModels` refs don't churn. Returns the
   * resulting `configuredModelId`s in input order.
   */
  bulkSet(providerId: string, infos: readonly ConfiguredModel["info"][]): Promise<string[]> {
    throw new Error("[modelManagement] ConfiguredModelRegistry.bulkSet not implemented yet");
  }

  /** Used by `ModelManagementCoordinator.removeProvider` to drop all
   *  models under a provider during cascade. */
  removeByProvider(providerId: string): Promise<void> {
    throw new Error(
      "[modelManagement] ConfiguredModelRegistry.removeByProvider not implemented yet"
    );
  }
}
