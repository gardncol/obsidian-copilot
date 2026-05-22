/**
 * BackendModelPicker — shared "Models in this backend's picker" surface.
 *
 * Used by all four Agent sub-panels (OpenCode / Claude Code / Codex /
 * Quick chat). Renders a checkbox list. Persists toggles by writing a
 * `<modelKey, boolean>` map back to `agentMode.backends.<id>.modelEnabledOverrides`
 * via the `onToggle` callback so the component stays storage-agnostic.
 *
 * Two render modes:
 *   - Flat: pass `rows: Row[]` — one list, no headers.
 *   - Sectioned: pass `sections: Section[]` — used by the OpenCode panel
 *     to group Bundled / Plus / BYOK with subtle visual dividers.
 *
 * Header includes a `Manage in BYOK →` link routed via a callback so this
 * component never knows how the host modal navigates between tabs.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §5.4 / §5.4.1 / §5.4.3.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import React from "react";

/**
 * One row in the model picker. `key` is the persistence key written into
 * `modelEnabledOverrides` — the bare `baseModelId` the backend reports
 * (e.g. `"anthropic/claude-sonnet-4-5"`, `"bigpickle/big-pickle"`,
 * `"claude-3-5-sonnet-20241022"`). No prefix: the per-backend scoping
 * comes from the storage path, not the key.
 */
export interface BackendModelPickerRow {
  /** Stable persistence key. The model's bare `baseModelId`. */
  key: string;
  /** Display name (e.g. "Claude Sonnet 4.5"). */
  name: string;
  /** Optional muted provider hint (e.g. "Anthropic"). */
  providerLabel?: string;
  /** Optional meta hint (e.g. "200k ctx", "local · 8B"). */
  meta?: string;
  /** Whether the row is currently enabled (checkbox checked). */
  enabled: boolean;
}

/**
 * Section grouping for sectioned mode. Used by the OpenCode panel to render
 * Bundled / Plus / BYOK as three groups with subtle dividers.
 */
export interface BackendModelPickerSection {
  /** Section title (e.g. "OpenCode-bundled"). */
  title: string;
  /** Rows under the title. Empty arrays render the optional `emptyPlaceholder`. */
  rows: BackendModelPickerRow[];
  /**
   * Placeholder line when `rows` is empty (e.g. "OpenCode-bundled models
   * will appear here"). When omitted, an empty section is suppressed.
   */
  emptyPlaceholder?: string;
}

interface CommonProps {
  /** Whether to show the `Manage in BYOK →` link in the header. Default `true`. */
  showManageInByokLink?: boolean;
  /**
   * Called when the user clicks `Manage in BYOK →`. Host wires this to its
   * tab-switching mechanism. Leaving this undefined hides the link.
   */
  onManageInByok?: () => void;
  /**
   * Persistence callback. The component itself doesn't know about settings —
   * the host passes a callback that writes
   * `agentMode.backends.<id>.modelEnabledOverrides[key] = enabled`.
   */
  onToggle: (key: string, enabled: boolean) => void;
}

interface FlatProps extends CommonProps {
  rows: BackendModelPickerRow[];
  sections?: undefined;
  /** Empty-state copy when `rows.length === 0`. */
  emptyPlaceholder?: string;
}

interface SectionedProps extends CommonProps {
  sections: BackendModelPickerSection[];
  rows?: undefined;
  emptyPlaceholder?: undefined;
}

export type BackendModelPickerProps = FlatProps | SectionedProps;

/**
 * Render one row. Wrapped in a label so the entire row toggles when clicked.
 */
const ModelRow: React.FC<{
  row: BackendModelPickerRow;
  onToggle: (key: string, enabled: boolean) => void;
}> = ({ row, onToggle }) => {
  return (
    <label
      className={cn(
        "tw-flex tw-cursor-pointer tw-items-center tw-justify-between tw-rounded tw-px-2 tw-py-1.5",
        "hover:tw-bg-modifier-hover"
      )}
      data-testid={`backend-model-row-${row.key}`}
    >
      <div className="tw-flex tw-min-w-0 tw-items-center tw-gap-3">
        <Checkbox
          checked={row.enabled}
          onCheckedChange={(checked) => onToggle(row.key, checked === true)}
          aria-label={`Toggle ${row.name}`}
          data-testid={`backend-model-checkbox-${row.key}`}
        />
        <div className="tw-min-w-0">
          <div className="tw-flex tw-items-center tw-gap-2 tw-truncate">
            <span className="tw-truncate tw-text-ui-small">{row.name}</span>
            {row.providerLabel && (
              <span className="tw-text-ui-smaller tw-text-muted">{row.providerLabel}</span>
            )}
          </div>
        </div>
      </div>
      {row.meta && <span className="tw-text-ui-smaller tw-text-muted">{row.meta}</span>}
    </label>
  );
};

/**
 * Render the picker. Behaves as flat or sectioned based on which prop the
 * caller provides.
 */
export const BackendModelPicker: React.FC<BackendModelPickerProps> = (props) => {
  const { onToggle, onManageInByok, showManageInByokLink = true } = props;
  const isSectioned = "sections" in props && props.sections !== undefined;

  return (
    <div data-testid="backend-model-picker">
      <div className="tw-mb-2 tw-flex tw-flex-wrap tw-items-baseline tw-justify-between tw-gap-2">
        <div className="tw-min-w-0">
          <div className="tw-text-ui-small tw-font-medium">Models in this backend's picker</div>
          <div className="tw-text-ui-smaller tw-text-muted">
            Tick which models show up when you switch model mid-session.
          </div>
        </div>
        {showManageInByokLink && onManageInByok && (
          <button
            type="button"
            onClick={onManageInByok}
            className="tw-flex tw-items-center tw-gap-1 tw-bg-transparent tw-text-ui-smaller tw-text-accent hover:tw-text-accent-hover hover:tw-underline"
            data-testid="manage-in-byok"
          >
            Manage in BYOK
            <ArrowRight className="tw-size-3" />
          </button>
        )}
      </div>

      {isSectioned ? (
        <SectionedList sections={props.sections} onToggle={onToggle} />
      ) : (
        <FlatList rows={props.rows} onToggle={onToggle} emptyPlaceholder={props.emptyPlaceholder} />
      )}
    </div>
  );
};

/**
 * Flat-mode body — one continuous list with an optional empty state.
 */
const FlatList: React.FC<{
  rows: BackendModelPickerRow[];
  emptyPlaceholder?: string;
  onToggle: (key: string, enabled: boolean) => void;
}> = ({ rows, emptyPlaceholder, onToggle }) => {
  if (rows.length === 0) {
    return (
      <div
        className="tw-rounded tw-border tw-border-dashed tw-border-border tw-px-3 tw-py-4 tw-text-center tw-text-ui-small tw-text-muted"
        data-testid="backend-model-picker-empty"
      >
        {emptyPlaceholder ?? "No models available yet."}
      </div>
    );
  }
  return (
    <div className="tw-space-y-0.5">
      {rows.map((row) => (
        <ModelRow key={row.key} row={row} onToggle={onToggle} />
      ))}
    </div>
  );
};

/**
 * Sectioned-mode body — one block per section, subtle divider between.
 */
const SectionedList: React.FC<{
  sections: BackendModelPickerSection[];
  onToggle: (key: string, enabled: boolean) => void;
}> = ({ sections, onToggle }) => {
  return (
    <div className="tw-space-y-3">
      {sections.map((section, idx) => {
        const isEmpty = section.rows.length === 0;
        if (isEmpty && !section.emptyPlaceholder) return null;
        return (
          <div
            key={section.title}
            data-testid={`backend-model-section-${section.title}`}
            className={cn(idx > 0 && "copilot-divider-t tw-pt-3")}
          >
            <div className="tw-mb-1 tw-text-ui-smaller tw-font-semibold tw-uppercase tw-text-muted">
              {section.title}
            </div>
            {isEmpty ? (
              <div
                className="tw-rounded tw-border tw-border-dashed tw-border-border tw-p-3 tw-text-center tw-text-ui-smaller tw-text-muted"
                data-testid={`backend-model-section-empty-${section.title}`}
              >
                {section.emptyPlaceholder}
              </div>
            ) : (
              <div className="tw-space-y-0.5">
                {section.rows.map((row) => (
                  <ModelRow key={row.key} row={row} onToggle={onToggle} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
