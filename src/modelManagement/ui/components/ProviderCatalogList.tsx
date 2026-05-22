/**
 * `ProviderCatalogList` — reusable checklist component used inside
 * `ConfigureProviderDialog` to surface a provider's catalog models.
 *
 * Layout per designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §5.2:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ ☑  Claude Sonnet 4.5         200k        Sep 2025  ⋯  │
 *   │ ☐  Claude Opus 4.1           200k        Aug 2024  ⋯  │
 *   └────────────────────────────────────────────────────────┘
 *
 * Key behaviors:
 *   - Catalog models render as `<row>` with a checkbox + name + context window
 *     + right-aligned release date column.
 *   - In `edit` state, registered rows show a `⋯` kebab (View docs / Remove
 *     from registry).
 *   - OpenRouter (whose ids look like `<upstream>/<modelId>`) gets sticky
 *     `<h>` upstream-provider headers grouping models by upstream namespace.
 *
 * The component is presentation-only — filter + search logic is applied by
 * the caller via `searchModels()` results. Persistence (which entries are
 * "selected") flows through the `selectedModelIds` prop and `onToggle`
 * callback.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CatalogModel } from "@/modelManagement/catalog/modelsCatalog.types";
import type { ProviderId } from "@/modelManagement/types";
import {
  formatContextWindow,
  formatReleaseDate,
} from "@/modelManagement/ui/utils/formatModelMetadata";
import { MoreHorizontal } from "lucide-react";
import React, { useMemo, useRef } from "react";

/**
 * Extract the upstream-provider namespace from an OpenRouter model id
 * (e.g. `anthropic/claude-sonnet-4.5` → `anthropic`). Returns `null` if the
 * id is not a `<namespace>/<rest>` shape.
 */
function openRouterUpstream(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  return modelId.slice(0, slash);
}

/**
 * Group a flat catalog-model array by OpenRouter upstream. Non-OpenRouter
 * callers get a single `"_"` bucket containing every model in original
 * order — so callers can always iterate the same shape.
 */
interface ProviderCatalogGroup {
  /** Upstream label (e.g. "anthropic"), or `null` for ungrouped lists. */
  upstream: string | null;
  models: CatalogModel[];
}

function groupForOpenRouter(models: CatalogModel[]): ProviderCatalogGroup[] {
  // Preserve insertion order while bucketing by upstream.
  const buckets = new Map<string, CatalogModel[]>();
  const ungrouped: CatalogModel[] = [];
  for (const model of models) {
    const upstream = openRouterUpstream(model.id);
    if (upstream === null) {
      ungrouped.push(model);
      continue;
    }
    const existing = buckets.get(upstream);
    if (existing) {
      existing.push(model);
    } else {
      buckets.set(upstream, [model]);
    }
  }
  const groups: ProviderCatalogGroup[] = [];
  for (const [upstream, list] of buckets) {
    groups.push({ upstream, models: list });
  }
  if (ungrouped.length > 0) {
    groups.push({ upstream: null, models: ungrouped });
  }
  return groups;
}

export interface ProviderCatalogListProps {
  /** The provider whose catalog we're listing — drives header grouping (e.g. OpenRouter). */
  providerId: ProviderId;
  /** Catalog models to render (already filtered/searched upstream). */
  models: CatalogModel[];
  /** `<providerId>:<modelId>` keys that are currently checked. */
  selectedModelIds: ReadonlySet<string>;
  /** Toggle one model's check state. */
  onToggle: (modelId: string) => void;
  /**
   * Edit-state mode: register existence of a `⋯` menu on already-registered
   * entries (View docs / Remove from registry). Defaults to `false`.
   */
  showKebab?: boolean;
  /** Set of `<providerId>:<modelId>` keys that are in the registry. Used to
   * show the kebab only for entries that actually live in the registry. */
  registeredModelIds?: ReadonlySet<string>;
  /** Edit-state callback when the user picks "View docs". */
  onViewDocs?: (modelId: string) => void;
  /** Edit-state callback when the user picks "Remove from registry". */
  onRemoveFromRegistry?: (modelId: string) => void;
  /** Rendered when `models.length === 0`. */
  emptyMessage?: React.ReactNode;
}

/**
 * `ProviderCatalogList` — see file header comment for layout + behavior.
 */
export const ProviderCatalogList: React.FC<ProviderCatalogListProps> = ({
  providerId,
  models,
  selectedModelIds,
  onToggle,
  showKebab = false,
  registeredModelIds,
  onViewDocs,
  onRemoveFromRegistry,
  emptyMessage,
}) => {
  const groups = useMemo<ProviderCatalogGroup[]>(() => {
    if (providerId === "openrouter") {
      return groupForOpenRouter(models);
    }
    return [{ upstream: null, models }];
  }, [providerId, models]);

  // Portal target for the per-row DropdownMenuContent. Without this, Radix
  // portals into `activeDocument.body` — outside the dialog's modal container —
  // where pointer events don't reach the menu items.
  const containerRef = useRef<HTMLDivElement>(null);

  if (models.length === 0) {
    return (
      <div
        className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-p-4 tw-text-center tw-text-sm tw-text-muted"
        data-testid="catalog-list-empty"
      >
        {emptyMessage ?? "No models match the current filters."}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "tw-flex tw-flex-col tw-overflow-hidden tw-rounded-md tw-border tw-border-solid tw-border-border"
      )}
      role="list"
      data-testid={`catalog-list-${providerId}`}
    >
      {groups.map((group, groupIdx) => (
        <CatalogGroupSection
          key={group.upstream ?? `__ungrouped-${groupIdx}`}
          providerId={providerId}
          group={group}
          selectedModelIds={selectedModelIds}
          onToggle={onToggle}
          showKebab={showKebab}
          registeredModelIds={registeredModelIds}
          onViewDocs={onViewDocs}
          onRemoveFromRegistry={onRemoveFromRegistry}
          isLastGroup={groupIdx === groups.length - 1}
          containerRef={containerRef}
        />
      ))}
    </div>
  );
};

interface CatalogGroupSectionProps {
  providerId: ProviderId;
  group: ProviderCatalogGroup;
  selectedModelIds: ReadonlySet<string>;
  onToggle: (modelId: string) => void;
  showKebab: boolean;
  registeredModelIds?: ReadonlySet<string>;
  onViewDocs?: (modelId: string) => void;
  onRemoveFromRegistry?: (modelId: string) => void;
  isLastGroup: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
}

const CatalogGroupSection: React.FC<CatalogGroupSectionProps> = ({
  providerId,
  group,
  selectedModelIds,
  onToggle,
  showKebab,
  registeredModelIds,
  onViewDocs,
  onRemoveFromRegistry,
  isLastGroup,
  containerRef,
}) => {
  const hasHeader = group.upstream !== null;
  return (
    <div role="group">
      {hasHeader && (
        <div
          className={cn(
            // Sticky upstream-provider header — sits at the top of its
            // group while the scroll container scrolls beneath it.
            "tw-sticky tw-top-0 tw-border-b tw-border-solid tw-border-border",
            "tw-bg-secondary-alt tw-px-3 tw-py-1 tw-text-ui-smaller tw-font-medium tw-text-muted"
          )}
          data-testid={`catalog-upstream-${group.upstream}`}
        >
          {group.upstream}
        </div>
      )}
      {group.models.map((model, modelIdx) => {
        const key = `${providerId}:${model.id}`;
        const isLastInGroup = modelIdx === group.models.length - 1;
        const isFinal = isLastGroup && isLastInGroup;
        return (
          <CatalogModelRow
            key={key}
            providerId={providerId}
            model={model}
            checked={selectedModelIds.has(key)}
            onToggle={() => onToggle(model.id)}
            showKebab={showKebab && (registeredModelIds?.has(key) ?? false)}
            onViewDocs={onViewDocs}
            onRemoveFromRegistry={onRemoveFromRegistry}
            isFinal={isFinal}
            containerRef={containerRef}
          />
        );
      })}
    </div>
  );
};

interface CatalogModelRowProps {
  providerId: ProviderId;
  model: CatalogModel;
  checked: boolean;
  onToggle: () => void;
  showKebab: boolean;
  onViewDocs?: (modelId: string) => void;
  onRemoveFromRegistry?: (modelId: string) => void;
  isFinal: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
}

const CatalogModelRow: React.FC<CatalogModelRowProps> = ({
  providerId,
  model,
  checked,
  onToggle,
  showKebab,
  onViewDocs,
  onRemoveFromRegistry,
  isFinal,
  containerRef,
}) => {
  const contextLabel = formatContextWindow(model.limit?.context);
  const releaseLabel = formatReleaseDate(model.release_date);
  const rowId = `${providerId}:${model.id}`;
  return (
    <div
      role="listitem"
      data-testid={`catalog-row-${providerId}-${model.id}`}
      className={cn(
        "tw-flex tw-items-center tw-gap-3 tw-px-3 tw-py-1.5 tw-text-sm",
        !isFinal && "tw-border-b tw-border-solid tw-border-border",
        "hover:tw-bg-primary-alt/40"
      )}
    >
      <Checkbox
        id={`row-${rowId}`}
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`Select ${model.name}`}
      />
      <label
        htmlFor={`row-${rowId}`}
        className="tw-flex tw-min-w-0 tw-flex-1 tw-cursor-pointer tw-items-center tw-gap-2"
      >
        <span className="tw-truncate tw-text-normal">{model.name}</span>
        {model.id !== model.name && (
          <Badge variant="outline" className="tw-shrink-0 tw-text-ui-smaller tw-text-muted">
            {model.id}
          </Badge>
        )}
      </label>
      <span className="tw-shrink-0 tw-text-xs tw-text-muted">{contextLabel ?? ""}</span>
      <span
        className="tw-w-20 tw-shrink-0 tw-text-right tw-text-xs tw-text-muted"
        data-testid={`catalog-release-${providerId}-${model.id}`}
      >
        {releaseLabel}
      </span>
      {showKebab ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`More actions for ${model.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="tw-size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" container={containerRef.current}>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onViewDocs?.(model.id);
              }}
            >
              View docs
            </DropdownMenuItem>
            <DropdownMenuItem
              className="tw-text-error"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveFromRegistry?.(model.id);
              }}
            >
              Remove from registry
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // Reserve same width as the kebab so the column line up regardless
        // of state. Using a sized spacer keeps the right-aligned release
        // column stable.
        <span aria-hidden className="tw-w-7" />
      )}
    </div>
  );
};

ProviderCatalogList.displayName = "ProviderCatalogList";
