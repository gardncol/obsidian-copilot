/**
 * `ProviderCatalogList` — reusable checklist of a catalog provider's
 * models, used inside `ConfigureProviderDialog`.

 * Presentation-only: selection lives in the `selected` prop and flows out
 * through `onToggle`. No internal state.
 */
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { CatalogProvider, ModelInfo } from "@/modelManagement/types/catalog";
import {
  formatContextWindow,
  formatReleaseDate,
} from "@/modelManagement/ui/utils/formatModelMetadata";
import { orderCatalogModels } from "@/modelManagement/ui/utils/orderCatalogModels";
import React, { useMemo } from "react";

const EMPTY_MODELS: readonly ModelInfo[] = Object.freeze([]);

export interface ProviderCatalogListProps {
  /** The provider whose catalog models we're listing. */
  catalog: CatalogProvider;
  /** Wire ids (`ModelInfo.id`) currently checked. */
  selected: ReadonlySet<string>;
  /** Toggle one model's check state. */
  onToggle: (wireId: string, next: boolean) => void;
  /** Optional case-insensitive substring filter over name + id. */
  query?: string;
  /** Rendered when no models match. */
  emptyMessage?: React.ReactNode;
}

/**
 * `ProviderCatalogList` — see file header for layout + behavior.
 */
export const ProviderCatalogList: React.FC<ProviderCatalogListProps> = ({
  catalog,
  selected,
  onToggle,
  query,
  emptyMessage,
}) => {
  const models = useMemo<readonly ModelInfo[]>(() => {
    const all = Object.values(catalog.models);
    if (all.length === 0) return EMPTY_MODELS;
    const needle = query?.trim().toLowerCase();
    const filtered = needle
      ? all.filter(
          (m) => m.displayName.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle)
        )
      : all;
    return orderCatalogModels(filtered, selected);
  }, [catalog.models, query, selected]);

  // Checked rows sort to the top (see `orderCatalogModels`), so a divider under
  // index `checkedCount - 1` separates the selected group — but only when the
  // groups are non-empty on both sides.
  const checkedCount = models.reduce((n, m) => (selected.has(m.id) ? n + 1 : n), 0);

  if (models.length === 0) {
    return (
      <div
        className={cn(
          "tw-rounded-md tw-border tw-border-solid tw-border-border tw-p-4",
          "tw-text-center tw-text-sm tw-text-muted"
        )}
        data-testid="catalog-list-empty"
      >
        {emptyMessage ?? "No models match the current filters."}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "tw-flex tw-min-h-0 tw-flex-1 tw-flex-col tw-overflow-y-auto tw-rounded-md",
        "tw-border tw-border-solid tw-border-border"
      )}
      role="list"
      data-testid={`catalog-list-${catalog.id}`}
    >
      {models.map((model, index) => {
        const checked = selected.has(model.id);
        const contextLabel = formatContextWindow(model.limits?.context);
        const releaseLabel = formatReleaseDate(model.releaseDate);
        const isLastChecked = index === checkedCount - 1 && checkedCount < models.length;
        return (
          <label
            key={model.id}
            role="listitem"
            data-testid={`catalog-row-${model.id}`}
            className={cn(
              "tw-grid tw-cursor-pointer tw-grid-cols-[auto_1fr_auto_auto] tw-items-center tw-gap-3",
              "tw-px-3 tw-py-1.5 tw-text-sm hover:tw-bg-primary-alt/40",
              isLastChecked && "copilot-divider-b"
            )}
          >
            <Checkbox
              checked={checked}
              onCheckedChange={(next) => onToggle(model.id, next === true)}
            />
            <span className="tw-flex tw-min-w-0 tw-items-center tw-gap-2">
              <span className="tw-truncate tw-text-normal">{model.displayName}</span>
              {model.isEmbedding && (
                <Badge variant="secondary" className="tw-shrink-0 tw-text-ui-smaller">
                  Embedding
                </Badge>
              )}
            </span>
            <span className="tw-shrink-0 tw-text-xs tw-text-muted">{contextLabel}</span>
            <span className="tw-w-20 tw-shrink-0 tw-text-right tw-text-xs tw-text-muted">
              {releaseLabel}
            </span>
          </label>
        );
      })}
    </div>
  );
};
