/**
 * Migration notice + dev command helpers.
 *
 * Wired into `main.ts` so the first post-migration plugin load surfaces a
 * one-time toast describing what changed (per §4.4), and so support staff
 * can dump the breadcrumb trail via the `Copilot: Show settings migration
 * status` command.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §4.4, §4.5.
 */
// Reason: `Modal` and `Plugin` are imported as types only at the top of
// this file. The runtime values are pulled in lazily inside
// `registerMigrationStatusCommand` so that test files that `jest.mock`
// `"obsidian"` with a partial stub (no `Modal`) can still load this
// module transitively without crashing on `class extends Modal`.
import { Notice, type App, type Modal as ModalType, type Plugin } from "obsidian";

import type { MigrationBreadcrumb } from "@/modelManagement/migrations/runMigrations";

/**
 * Build the toast copy from the most recent migration's `droppedFields`
 * list. Groups fields into high-level categories for human readability.
 */
function buildNoticeMessage(breadcrumb: MigrationBreadcrumb): string {
  const dropped = breadcrumb.droppedFields ?? [];
  const lines: string[] = ["Copilot settings upgraded."];

  const overrideHit = dropped.some((f) =>
    /\.(temperature|maxTokens|topP|frequencyPenalty|numCtx|reasoningEffort|verbosity|stream|streamUsage|useResponsesApi|enablePromptCaching|enableCors|capabilities)$/.test(
      f
    )
  );
  if (overrideHit) {
    lines.push("• Per-model temperature / max-tokens / capability overrides removed.");
  }

  // The legacy `defaultModelKey` string has been migrated to the structured
  // `defaultModelRef` ref (resolved through the BYOK registry). The Quick
  // Chat agent backend no longer carries a persisted default — new sessions
  // inherit the previous active session's (model, effort), falling back to
  // the catalog default on reload. Mention the move so users know the toggle
  // list now lives in the Agent panel.
  lines.push("• Default chat model now lives under Agent → Quick Chat.");

  const keyHit = dropped.some((f) => /settings\..*ApiKey.*legacy-pending-deletion/.test(f));
  if (keyHit) {
    lines.push("• Provider keys moved to the new BYOK tab.");
  }

  const builtinDrops = dropped.filter((f) => f.includes("isBuiltIn-no-key")).length;
  if (builtinDrops > 0) {
    lines.push(
      `• Pre-listed built-in models removed for providers you hadn't configured. (${builtinDrops} removed)`
    );
  }

  return lines.join("\n");
}

/**
 * Show the §4.4 toast if a migration has been recorded and the user
 * hasn't already dismissed it. The "dismiss" half (writing
 * `_migrationNoticeDismissed`) is handled by the Notice's auto-close
 * behavior in Obsidian; we mark it dismissed unconditionally after the
 * user has seen the toast once.
 */
export function maybeShowMigrationNotice(
  breadcrumb: MigrationBreadcrumb | undefined,
  noticeAlreadyDismissed: boolean,
  markDismissed: () => void
): void {
  if (!breadcrumb) return;
  if (noticeAlreadyDismissed) return;

  const message = buildNoticeMessage(breadcrumb);
  new Notice(message, 0); // 0 = sticky until the user dismisses.
  markDismissed();
}

/**
 * Build a Modal subclass lazily so module load doesn't depend on the
 * `Modal` runtime symbol being present. Tests that stub `"obsidian"` with
 * a partial mock can transitively import this file without crashing.
 */
function makeMigrationStatusModalClass(): new (
  app: App,
  breadcrumbs: MigrationBreadcrumb[]
) => ModalType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const obsidian = require("obsidian") as { Modal: new (app: App) => ModalType };
  return class MigrationStatusModal extends obsidian.Modal {
    private readonly breadcrumbs: MigrationBreadcrumb[];

    constructor(app: App, breadcrumbs: MigrationBreadcrumb[]) {
      super(app);
      this.breadcrumbs = breadcrumbs;
    }

    onOpen(): void {
      this.titleEl.setText("Copilot — settings migration status");
      if (this.breadcrumbs.length === 0) {
        this.contentEl.createEl("p", {
          text: "No migrations have been applied to this vault.",
        });
        return;
      }
      for (const crumb of this.breadcrumbs) {
        const block = this.contentEl.createDiv();
        block.createEl("h4", {
          text: `v${crumb.from} → v${crumb.to} (applied ${new Date(
            crumb.appliedAt
          ).toLocaleString()})`,
        });
        const fields = crumb.droppedFields ?? [];
        if (fields.length === 0) {
          block.createEl("p", { text: "(no dropped fields recorded)" });
        } else {
          block.createEl("p", { text: `${fields.length} dropped field(s):` });
          const list = block.createEl("ul");
          for (const f of fields) list.createEl("li", { text: f });
        }
      }
    }

    onClose(): void {
      this.contentEl.empty();
    }
  };
}

/**
 * Register the dev command on the given plugin instance. Safe to call
 * unconditionally — the command always exists, even when no migration has
 * been applied (the modal will just say "no migrations applied").
 */
export function registerMigrationStatusCommand(
  plugin: Plugin,
  getBreadcrumbs: () => MigrationBreadcrumb[]
): void {
  plugin.addCommand({
    id: "show-settings-migration-status",
    name: "Show settings migration status",
    callback: () => {
      const ModalCtor = makeMigrationStatusModalClass();
      new ModalCtor(plugin.app, getBreadcrumbs()).open();
    },
  });
}
