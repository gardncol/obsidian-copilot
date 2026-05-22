/**
 * Single global table that renders every BYOK provider as a section row
 * with indented model rows beneath it.
 *
 * Layout:
 *
 *   ▼ Anthropic       4 models                                ⋮
 *         Claude Sonnet 4.5
 *         Claude Opus 4.1
 *
 * - OpenCode-bundled and Copilot Plus models do NOT appear here, ever.
 * - Model rows are display-only. To edit which models are registered for a
 *   provider, use the Configure entry in the section's overflow menu.
 * - Providers with no registered models are filtered out upstream.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService";
import type { ProviderConfig, RegistryEntry } from "@/modelManagement/types";
import {
  formatContextWindow,
  formatReleaseDate,
} from "@/modelManagement/ui/utils/formatModelMetadata";
import { ChevronDown, ChevronRight, MoreVertical, Settings2, Trash2 } from "lucide-react";
import React, { useRef, useState } from "react";

/**
 * One provider row plus the registry entries that belong to it. The owning
 * panel sorts / filters / groups; this component just renders.
 */
export interface ByokTableProviderGroup {
  provider: ProviderConfig;
  entries: RegistryEntry[];
}

interface ByokGlobalTableProps {
  groups: ByokTableProviderGroup[];
  /** Called when the user picks "Configure" from the section's overflow menu. */
  onConfigureProvider: (providerId: string) => void;
  /** Called when the user confirms "Remove provider" from the overflow menu. */
  onRemoveProvider: (providerId: string) => void;
}

/**
 * `ByokGlobalTable` — single CSS-grid "table" so model rows can sit
 * underneath provider section rows in the same column layout. A real
 * `<table>` would force every section header into a single `<tr>` row,
 * which fights the design's "section row + indented children" shape.
 */
export const ByokGlobalTable: React.FC<ByokGlobalTableProps> = ({
  groups,
  onConfigureProvider,
  onRemoveProvider,
}) => {
  // TODO(persistence): The spec says "remembers state per provider"; M4
  // accepts in-component state and resets across remounts. A future
  // pass can lift this into settings or sessionStorage keyed by id.
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({});
  // Portal target for the per-row DropdownMenuContent. Without this, Radix
  // portals into `activeDocument.body` — outside Obsidian's settings modal —
  // where pointer events don't reach the menu items.
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = (providerId: string): void => {
    setOpenProviders((prev) => ({
      ...prev,
      // Default to open if the key has never been touched.
      [providerId]: prev[providerId] === undefined ? false : !prev[providerId],
    }));
  };

  const isOpen = (providerId: string): boolean => openProviders[providerId] !== false;

  if (groups.length === 0) {
    return (
      <div className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-p-6 tw-text-center tw-text-sm tw-text-muted">
        No providers match the current filters.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "tw-w-full tw-overflow-hidden tw-rounded-md tw-border tw-border-solid tw-border-border"
      )}
      role="table"
    >
      {groups.map((group, idx) => (
        <React.Fragment key={group.provider.id}>
          {idx > 0 && <div role="separator" className="tw-h-px tw-bg-primary-alt" />}
          <ProviderSection
            group={group}
            isOpen={isOpen(group.provider.id)}
            onToggle={() => toggle(group.provider.id)}
            onConfigure={() => onConfigureProvider(group.provider.id)}
            onRemove={() => onRemoveProvider(group.provider.id)}
            containerRef={containerRef}
          />
        </React.Fragment>
      ))}
    </div>
  );
};

interface ProviderSectionProps {
  group: ByokTableProviderGroup;
  isOpen: boolean;
  onToggle: () => void;
  onConfigure: () => void;
  onRemove: () => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

/**
 * One provider section: header row + collapsible model rows.
 */
const ProviderSection: React.FC<ProviderSectionProps> = ({
  group,
  isOpen,
  onToggle,
  onConfigure,
  onRemove,
  containerRef,
}) => {
  const { provider, entries } = group;
  const headerClass = cn(
    "tw-flex tw-items-center tw-gap-2 tw-px-3 tw-py-2 tw-text-sm",
    "tw-cursor-pointer hover:tw-bg-primary-alt/50"
  );
  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <div role="rowgroup">
      <div
        role="row"
        className={headerClass}
        onClick={onToggle}
        data-provider-id={provider.id}
        data-testid={`byok-section-${provider.id}`}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-expanded={isOpen}
          aria-label={
            isOpen ? `Collapse ${provider.displayName}` : `Expand ${provider.displayName}`
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <Chevron className="tw-size-4" />
        </Button>
        <span className="tw-font-medium tw-text-normal">{provider.displayName}</span>
        <span className="tw-text-xs tw-text-muted">
          {entries.length} {entries.length === 1 ? "model" : "models"}
        </span>
        {provider.kind === "custom" && (
          <Badge variant="outline" className="tw-text-ui-smaller">
            custom endpoint
          </Badge>
        )}
        <span className="tw-flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              aria-label={`More actions for ${provider.displayName}`}
            >
              <MoreVertical className="tw-size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" container={containerRef.current}>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onConfigure();
              }}
            >
              <Settings2 className="tw-mr-2 tw-size-4" />
              Configure
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="tw-text-error"
            >
              <Trash2 className="tw-mr-2 tw-size-4" />
              Remove provider
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isOpen &&
        entries.map((entry) => (
          <ModelRow key={`${entry.providerId}:${entry.modelId}`} entry={entry} />
        ))}
    </div>
  );
};

interface ModelRowProps {
  entry: RegistryEntry;
}

const ModelRow: React.FC<ModelRowProps> = ({ entry }) => {
  // Capabilities (context window, release date) are looked up at render time
  // from the catalog — never snapshotted into the registry entry. When the
  // catalog hasn't loaded a provider/model yet (e.g. custom models, or before
  // first refresh) both cells render as an em dash.
  const catalogModel = ModelCatalogService.getInstance().getModel(entry.providerId, entry.modelId);
  const contextLabel = formatContextWindow(catalogModel?.limit?.context);
  const releaseLabel = formatReleaseDate(catalogModel?.release_date);
  return (
    <div
      role="row"
      data-testid={`byok-model-${entry.providerId}-${entry.modelId}`}
      className={cn(
        "tw-grid tw-grid-cols-[1fr_auto_auto] tw-items-center tw-gap-3 tw-px-3 tw-py-1.5 tw-pl-10 tw-text-sm"
      )}
    >
      <div className="tw-truncate tw-text-normal">{entry.displayName}</div>
      <span
        className="tw-shrink-0 tw-text-xs tw-text-muted"
        data-testid={`byok-model-context-${entry.providerId}-${entry.modelId}`}
      >
        {contextLabel ?? "—"}
      </span>
      <span
        className="tw-w-20 tw-shrink-0 tw-text-right tw-text-xs tw-text-muted"
        data-testid={`byok-model-release-${entry.providerId}-${entry.modelId}`}
      >
        {releaseLabel || "—"}
      </span>
    </div>
  );
};

ByokGlobalTable.displayName = "ByokGlobalTable";
