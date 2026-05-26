import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SearchBar } from "@/components/ui/SearchBar";
import { SettingSwitch } from "@/components/ui/setting-switch";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import React from "react";

/** A single toggleable model row. */
export interface ModelEnableRow {
  /** Stable identity used for the toggle callback (a `configuredModelId`). */
  id: string;
  /** Primary label shown to the user. */
  label: string;
  /** Optional secondary line (e.g. wire id / description). */
  description?: string;
  /** Whether the model is currently enabled. */
  enabled: boolean;
}

/** A provider-display-name-grouped section of model rows. */
export interface ModelEnableGroup {
  /** Stable key used for collapse state + React keys. */
  key: string;
  /** Group heading — a provider display name (no glyphs/avatars). */
  label: string;
  /**
   * When `true`, the group renders inside a `Collapsible` with a count and
   * starts collapsed by default. When `false`/omitted the rows render
   * directly (small, always-visible groups).
   */
  collapsible?: boolean;
  rows: ModelEnableRow[];
}

interface ModelEnableListProps {
  /** Provider-grouped rows to render. Already filtered/derived by the caller. */
  groups: ModelEnableGroup[];
  /** Toggle handler — `enabled` is the next desired state. */
  onToggle: (id: string, enabled: boolean) => void;
  /** Search query (controlled). */
  query: string;
  onQueryChange: (next: string) => void;
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
  /** Rendered when there are no groups/rows to show (after filtering). */
  emptyState?: React.ReactNode;
}

/**
 * Presentational toggle list for agent model curation: provider-grouped rows
 * (optionally collapsible), a search box, and a switch per row. Owns no
 * registry/atom access — the container passes grouped data and `onToggle`.
 * Group headings show the provider display name only (no glyphs/avatars).
 */
export const ModelEnableList: React.FC<ModelEnableListProps> = ({
  groups,
  onToggle,
  query,
  onQueryChange,
  searchPlaceholder = "Search models…",
  emptyState,
}) => {
  // Per-group user-controlled expand state. While searching every group with
  // matches auto-expands so results are visible without an extra click.
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const searching = query.trim().length > 0;

  const isExpanded = (group: ModelEnableGroup): boolean => {
    if (!group.collapsible) return true;
    if (searching) return true;
    const userToggle = expanded[group.key];
    if (typeof userToggle === "boolean") return userToggle;
    // Collapsible groups default to collapsed.
    return false;
  };

  const toggleExpanded = (group: ModelEnableGroup): void => {
    const currentlyOpen = isExpanded(group);
    setExpanded((prev) => ({ ...prev, [group.key]: !currentlyOpen }));
  };

  const renderRows = (rows: ModelEnableRow[]): React.ReactNode => (
    <div className="tw-space-y-1">
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "tw-flex tw-items-center tw-justify-between tw-gap-2 tw-rounded tw-px-2 tw-py-1",
            "hover:tw-bg-modifier-hover"
          )}
        >
          <div className="tw-min-w-0">
            <div className="tw-truncate">{row.label}</div>
            {row.description && (
              <div className="tw-truncate tw-text-xs tw-text-muted">{row.description}</div>
            )}
          </div>
          <SettingSwitch checked={row.enabled} onCheckedChange={(next) => onToggle(row.id, next)} />
        </div>
      ))}
    </div>
  );

  const hasRows = groups.some((g) => g.rows.length > 0);

  return (
    <div className="tw-flex tw-flex-col tw-gap-2">
      <SearchBar value={query} onChange={onQueryChange} placeholder={searchPlaceholder} />

      <div className="tw-max-h-80 tw-overflow-y-auto tw-pr-1">
        {!hasRows ? (
          <div className="tw-py-6 tw-text-center tw-text-sm tw-text-muted">
            {emptyState ?? (searching ? `No models match “${query.trim()}”.` : "No models.")}
          </div>
        ) : (
          <div className="tw-space-y-2">
            {groups
              .filter((g) => g.rows.length > 0)
              .map((group) =>
                group.collapsible ? (
                  <Collapsible
                    key={group.key}
                    open={isExpanded(group)}
                    onOpenChange={() => toggleExpanded(group)}
                  >
                    <CollapsibleTrigger
                      className={cn(
                        "tw-flex tw-w-full tw-items-center tw-justify-between tw-rounded tw-px-2 tw-py-1.5 tw-text-left",
                        "hover:tw-bg-modifier-hover"
                      )}
                      type="button"
                    >
                      <div className="tw-flex tw-items-center tw-gap-2">
                        {isExpanded(group) ? (
                          <ChevronDown className="tw-size-4 tw-text-muted" />
                        ) : (
                          <ChevronRight className="tw-size-4 tw-text-muted" />
                        )}
                        <span className="tw-font-medium">{group.label}</span>
                      </div>
                      <span className="tw-text-xs tw-text-muted">{group.rows.length}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="tw-mt-1 tw-pl-6">{renderRows(group.rows)}</div>
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <div key={group.key}>
                    <div className="tw-px-2 tw-py-1.5 tw-font-medium">{group.label}</div>
                    <div className="tw-pl-2">{renderRows(group.rows)}</div>
                  </div>
                )
              )}
          </div>
        )}
      </div>
    </div>
  );
};
