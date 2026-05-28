/**
 * One-time settings migrations, run once on plugin load (from `Plugin.onload`,
 * after the settings-persistence subscriber is wired so every mutation is
 * persisted, and before agent/model-discovery init so OpenCode first sees the
 * migrated backends).
 *
 * The gate is deliberately a plain version comparison — there is a single
 * one-time migration today (legacy BYOK → model-management). Promote this to an
 * ordered runner only if a second migration ever accrues.
 */

import { logInfo } from "@/logger";
import type { ModelManagementApi } from "@/modelManagement";
import { getSettings, setSettings } from "@/settings/model";

import { executeByokMigration } from "./byokMigration";
import { CURRENT_SETTINGS_VERSION } from "./version";

export { CURRENT_SETTINGS_VERSION } from "./version";

/**
 * Run pending one-time migrations and stamp the new version. No-op when
 * settings are already at/above the target (migrated vaults, fresh installs).
 */
export async function runSettingsMigrations(api: ModelManagementApi): Promise<void> {
  const fromVersion = getSettings().settingsVersion ?? 0;
  if (fromVersion >= CURRENT_SETTINGS_VERSION) return;

  logInfo(`[settings-migration] migrating from v${fromVersion} to v${CURRENT_SETTINGS_VERSION}`);
  await executeByokMigration(api, getSettings());
  // Bump unconditionally after the migration so a per-provider failure can't
  // wedge the gate into re-running on every load. Persists via the subscriber.
  setSettings({ settingsVersion: CURRENT_SETTINGS_VERSION });
}
