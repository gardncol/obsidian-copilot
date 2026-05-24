/**
 * `AddProviderModal` — entry point for picking a catalog provider to add.
 *
 *   [🔍 Search providers…]
 *
 *   Recommended
 *     Anthropic — Claude family             [ Add → ]
 *     OpenAI    — GPT family                [ Add → ]
 *     Google    — Gemini family             [ Add → ]
 *
 *   More providers
 *     Cohere                                       +
 *     DeepSeek                                     +
 *     …
 *   ┌─ + Add a custom provider (disabled) ──────────────┐
 *
 * Behaviors:
 *   - Lists every catalog provider; no "already added" filtering
 *     (multi-instance is allowed — the user edits via Configure or adds
 *     another instance freely).
 *   - Search is a case-insensitive substring match on the display name.
 *   - Picking a row calls `onPick(catalog)`.
 *   - The custom-provider CTA is rendered but disabled (templates ship in
 *     a later release).
 *
 * Hosted in a native Obsidian `Modal` (popout-correct, native chrome).
 * `AddProviderContent` is the pure body, exported for unit tests.
 */
import { ReactModal } from "@/components/modals/ReactModal";
import { SearchBar } from "@/components/ui/SearchBar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CatalogProvider } from "@/modelManagement/types/catalog";
import { Plus } from "lucide-react";
import { App } from "obsidian";
import React, { useMemo, useState } from "react";

/** Top-row recommended catalog ids. Order matters. */
const RECOMMENDED_IDS: readonly string[] = ["anthropic", "openai", "google"];

/** Short descriptors shown next to each recommended provider. */
const RECOMMENDED_DESCRIPTIONS: Record<string, string> = {
  anthropic: "Claude family",
  openai: "GPT family",
  google: "Gemini family",
};

export interface AddProviderContentProps {
  /** Catalog snapshot, owned by the panel (loaded via the catalog service). */
  catalogProviders: readonly CatalogProvider[];
  /** Called when the user picks a catalog provider. */
  onPick: (catalog: CatalogProvider) => void;
}

/** Case-insensitive substring match on display name. */
function matchesQuery(provider: CatalogProvider, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return provider.displayName.toLowerCase().includes(needle);
}

/**
 * `AddProviderContent` — see file header for layout + behavior. Pure body;
 * the modal shell owns open/close and chrome.
 */
export const AddProviderContent: React.FC<AddProviderContentProps> = ({
  catalogProviders,
  onPick,
}) => {
  const [query, setQuery] = useState("");

  const { recommended, more } = useMemo(() => {
    const byId = new Map(catalogProviders.map((p) => [p.id, p]));
    const recommended = RECOMMENDED_IDS.map((id) => byId.get(id)).filter(
      (p): p is CatalogProvider => p !== undefined && matchesQuery(p, query)
    );
    const more = catalogProviders
      .filter((p) => !RECOMMENDED_IDS.includes(p.id) && matchesQuery(p, query))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { recommended, more };
  }, [catalogProviders, query]);

  const noMatches = recommended.length === 0 && more.length === 0;

  return (
    <div className="tw-flex tw-h-full tw-min-h-0 tw-flex-col tw-gap-4 tw-overflow-hidden tw-px-2">
      <div className="tw-text-sm tw-text-muted">Pick a provider to configure.</div>

      <SearchBar value={query} onChange={setQuery} placeholder="Search providers…" />

      <div className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col tw-gap-4 tw-overflow-y-auto">
        {recommended.length > 0 && (
          <section data-testid="add-provider-recommended">
            <div className="tw-mb-2 tw-text-ui-smaller tw-font-medium tw-uppercase tw-tracking-wide tw-text-muted">
              Recommended
            </div>
            <div className="tw-flex tw-flex-col tw-gap-0.5">
              {recommended.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  description={RECOMMENDED_DESCRIPTIONS[p.id]}
                  onClick={() => onPick(p)}
                />
              ))}
            </div>
          </section>
        )}

        {more.length > 0 && (
          <section data-testid="add-provider-more">
            <div className="tw-mb-2 tw-text-ui-smaller tw-font-medium tw-uppercase tw-tracking-wide tw-text-muted">
              More providers
            </div>
            <div className="tw-flex tw-flex-col tw-gap-0.5">
              {more.map((p) => (
                <ProviderRow key={p.id} provider={p} onClick={() => onPick(p)} />
              ))}
            </div>
          </section>
        )}

        {noMatches && (
          <div className="tw-rounded-md tw-border tw-border-dashed tw-border-border tw-px-4 tw-py-6 tw-text-center tw-text-sm tw-text-muted">
            No providers match your search.
          </div>
        )}
      </div>

      <CustomProviderCta />
    </div>
  );
};

interface ProviderRowProps {
  provider: CatalogProvider;
  onClick: () => void;
  /** Optional "— family" descriptor (recommended rows only). */
  description?: string;
}

/** Provider row: name + optional "— family" descriptor + trailing plus.
 *  No background; shared by both the Recommended and More sections so the
 *  add affordance is identical everywhere. */
const ProviderRow: React.FC<ProviderRowProps> = ({ provider, onClick, description }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    }}
    data-testid={`add-provider-card-${provider.id}`}
    aria-label={`Add ${provider.displayName} provider`}
    className={cn(
      "tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-gap-3 tw-rounded-md",
      "tw-border tw-border-solid tw-border-transparent tw-px-3 tw-py-1.5 tw-text-left",
      "hover:tw-border-border hover:tw-bg-primary-alt/40"
    )}
  >
    <span className="tw-flex tw-min-w-0 tw-flex-1 tw-items-baseline tw-gap-1.5 tw-truncate">
      <span className="tw-truncate tw-text-sm tw-text-normal">{provider.displayName}</span>
      {description && (
        <span className="tw-truncate tw-text-ui-smaller tw-text-muted">— {description}</span>
      )}
    </span>
    <Plus className="tw-size-4 tw-shrink-0 tw-text-muted" />
  </div>
);

/** Disabled "Add a custom provider" CTA with a coming-soon tooltip. */
const CustomProviderCta: React.FC = () => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-testid="add-provider-custom-cta"
          aria-disabled
          className={cn(
            "tw-mt-2 tw-flex tw-w-full tw-flex-col tw-items-center tw-gap-1 tw-rounded-md tw-p-4",
            "tw-border tw-border-dashed tw-bg-interactive-accent/10 tw-border-interactive-accent/40",
            "tw-cursor-not-allowed tw-opacity-50"
          )}
        >
          <div className="tw-flex tw-items-center tw-gap-1.5 tw-font-medium tw-text-accent">
            <Plus className="tw-size-4" />
            Add a custom provider
          </div>
          <div className="tw-text-ui-smaller tw-text-muted">
            Bring your own endpoint (OpenAI-compatible, Anthropic, or Google API).
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Coming soon — Ollama / LM Studio / Azure / Bedrock support is in the next release.
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

interface AddProviderModalOptions {
  /** Catalog snapshot, owned by the panel (loaded via the catalog service). */
  catalogProviders: readonly CatalogProvider[];
  /** Called when the user picks a catalog provider (modal closes afterward). */
  onPick: (catalog: CatalogProvider) => void;
}

/**
 * Native Obsidian modal hosting {@link AddProviderContent}. Picking a
 * provider fires `onPick` then closes the modal.
 */
export class AddProviderModal extends ReactModal {
  constructor(
    app: App,
    private readonly opts: AddProviderModalOptions
  ) {
    super(app, "Add a provider");
  }

  onOpen(): void {
    // Fixed, slightly-shorter-than-settings height so the provider list
    // scrolls inside the modal and the custom-provider CTA stays pinned to
    // the bottom. The modal and its content must be a bounded flex column for
    // the inner `flex-1 + overflow-y-auto` region to bound.
    this.modalEl.addClasses(["tw-flex", "tw-h-[70vh]", "tw-flex-col"]);
    this.contentEl.addClasses([
      "tw-flex",
      "tw-min-h-0",
      "tw-flex-1",
      "tw-flex-col",
      "tw-overflow-hidden",
    ]);
    super.onOpen();
  }

  protected renderContent(close: () => void): React.ReactElement {
    return (
      <AddProviderContent
        catalogProviders={this.opts.catalogProviders}
        onPick={(catalog) => {
          this.opts.onPick(catalog);
          close();
        }}
      />
    );
  }
}
