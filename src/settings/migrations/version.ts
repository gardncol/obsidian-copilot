/**
 * Settings schema version. Bumped by the one-time migrations in this folder.
 *
 * Kept in its own leaf module (no heavy imports) so low-level code like the
 * settings-persistence layer can stamp fresh installs without pulling in the
 * model-management barrel that `runSettingsMigrations` depends on.
 *
 * `= 4` matches the v4 launch. Gate is `(settingsVersion ?? 0) < CURRENT`, so
 * pre-versioned installs (real users → `0`) and the orphaned prototype `2`
 * both run; migrated vaults (`4`) and freshly-stamped installs skip.
 */
export const CURRENT_SETTINGS_VERSION = 4;
