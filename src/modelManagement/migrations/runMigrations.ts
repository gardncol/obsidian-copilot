/**
 * Settings migration runner. Owns the chain of versioned migrations applied
 * inside `sanitizeSettings`.
 *
 * Synchronous by contract — `sanitizeSettings` is sync, and the catalog data
 * needed for capability inference is loaded from the bundled fallback JSON
 * imported at module load (no `await`).
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §2.4 and §4.
 */
import { migrateV0toV2 } from "@/modelManagement/migrations/v0-to-v2";

// Reason: the migration runner is called from `sanitizeSettings`, which
// runs DURING settings load. `@/logger` imports `getSettings()` from
// `@/settings/model` — pulling the logger in here creates a heavy cycle
// (and load-time hazards). Use `console.*` directly for the same reason
// `KeychainService` does (see its file header).
function logInfo(msg: string): void {
  // eslint-disable-next-line obsidianmd/rule-custom-message
  console.info(msg);
}
function logError(msg: string): void {
  console.error(msg);
}

/** Current schema version after this redesign. */
export const CURRENT_SETTINGS_VERSION = 2;

type Migration = (raw: Record<string, unknown>) => {
  settings: Record<string, unknown>;
  droppedFields: string[];
};

/**
 * Migration chain keyed by the version they upgrade TO.
 *
 * For now there's only one entry (v0/undefined → v2). Future migrations
 * append more entries and `runMigrations` walks them in numerical order.
 */
const MIGRATIONS: Record<number, Migration> = {
  2: migrateV0toV2,
};

/** Breadcrumb shape recorded in `_migrationBreadcrumbs`. */
export interface MigrationBreadcrumb {
  from: number;
  to: number;
  appliedAt: number;
  droppedFields?: string[];
}

/**
 * Run any pending migrations against the raw settings object.
 *
 * Behavior:
 *  - Operates on a deep clone of the input; the original is never mutated.
 *  - Idempotent: if `settingsVersion >= CURRENT`, returns input unchanged.
 *  - On any thrown error, logs via `logError`, returns the original input
 *    untouched, and reports an empty `migrationsApplied` list so the caller
 *    can decide whether to surface a one-time notice.
 *  - Appends a breadcrumb entry per migration step.
 */
export function runModelManagementMigrations<TSettings extends object>(
  raw: TSettings | null | undefined
): { settings: TSettings; migrationsApplied: number[] } {
  if (!raw || typeof raw !== "object") {
    return {
      settings: raw as unknown as TSettings,
      migrationsApplied: [],
    };
  }

  // Deep clone defensively — migration mutates its working copy.
  let working: Record<string, unknown>;
  try {
    working = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  } catch (err) {
    logError(`[runMigrations] Failed to deep-clone settings: ${String(err)}`);
    return { settings: raw, migrationsApplied: [] };
  }

  const currentVersion = Number(working.settingsVersion ?? 0);
  if (currentVersion >= CURRENT_SETTINGS_VERSION) {
    return { settings: raw, migrationsApplied: [] };
  }

  const applied: number[] = [];
  let fromVersion = currentVersion;

  // Walk migrations in ascending version order, skipping already-applied ones.
  const pendingVersions = Object.keys(MIGRATIONS)
    .map((v) => Number(v))
    .sort((a, b) => a - b)
    .filter((v) => v > currentVersion);

  for (const toVersion of pendingVersions) {
    const migrate = MIGRATIONS[toVersion];
    try {
      const { settings: migrated, droppedFields } = migrate(working);
      working = migrated;
      const breadcrumb: MigrationBreadcrumb = {
        from: fromVersion,
        to: toVersion,
        appliedAt: Date.now(),
        ...(droppedFields.length > 0 ? { droppedFields } : {}),
      };
      const crumbs = Array.isArray(working._migrationBreadcrumbs)
        ? (working._migrationBreadcrumbs as MigrationBreadcrumb[])
        : [];
      crumbs.push(breadcrumb);
      working._migrationBreadcrumbs = crumbs;
      working.settingsVersion = toVersion;
      applied.push(toVersion);
      fromVersion = toVersion;
      logInfo(
        `[runMigrations] Applied migration v${breadcrumb.from} → v${breadcrumb.to} (${droppedFields.length} dropped fields).`
      );
    } catch (err) {
      logError(
        `[runMigrations] Migration to v${toVersion} threw — restoring original settings. Error: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      // Restore the input untouched on any error.
      return { settings: raw, migrationsApplied: [] };
    }
  }

  return { settings: working as unknown as TSettings, migrationsApplied: applied };
}
