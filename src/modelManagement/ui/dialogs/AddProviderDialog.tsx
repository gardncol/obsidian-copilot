/**
 * `AddProviderDialog` — entry point for picking a new provider to add.
 *
 * Layout per the consolidated "AddProviderV1 — categorized list" design
 * (final.jsx ➜ FinalAddProvider):
 *
 *   [🔍 Search providers…]
 *
 *   Recommended
 *     [An] Anthropic — Claude family             [ Add → ]
 *     [Op] OpenAI    — GPT family                [ Add → ]
 *     [Go] Google    — Gemini family             [ Add → ]
 *
 *   More providers
 *     [Co] Cohere                                       +
 *     [De] DeepSeek                                     +
 *     …
 *   ───────────────────────────────────────────────────
 *   ┌─ + Add a custom provider ─────────────────────────┐
 *   │  Bring your own endpoint (OpenAI-compatible / …)  │
 *   └────────────────────────────────────────────────────┘
 *
 * Behaviors:
 *   - Providers already in `settings.providers` are filtered out (the user
 *     can edit them via Configure rather than re-add).
 *   - "More providers" excludes `openai-compatible` — that path is reserved
 *     for the custom-provider flow.
 *   - The search box does a case-insensitive substring match against both
 *     the display name and the provider id.
 *   - Picking a built-in row calls `onPickBuiltin(providerId)`; the custom
 *     CTA calls `onPickCustom()`.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchBar } from "@/components/ui/SearchBar";
import { useTabOptional } from "@/contexts/TabContext";
import { cn } from "@/lib/utils";
import type { ProviderConfig, ProviderId } from "@/modelManagement/types";
import { SUPPORTED_PROVIDER_IDS } from "@/modelManagement/providers/supportedProviders";
import { Plus } from "lucide-react";
import React, { useMemo, useState } from "react";

/**
 * Top-row recommended providers per the design. Order matters: Anthropic →
 * OpenAI → Google.
 */
const RECOMMENDED_PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "google"];

/**
 * Excluded from the "More providers" picker — these are special:
 *   - `openai-compatible` is used internally as the custom-provider's type;
 *     it never appears as a pickable built-in.
 */
const EXCLUDED_FROM_MORE: ReadonlySet<ProviderId> = new Set(["openai-compatible"]);

/**
 * Display-friendly labels for built-in providers. The values mirror what
 * `models.dev/api.json` returns in `name` for the providers that exist in
 * the catalog; providers without catalog entries (ollama / lmstudio /
 * openai-compatible) use hand-rolled labels.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  cohere: "Cohere",
  azure: "Azure",
  "amazon-bedrock": "Amazon Bedrock",
  "github-copilot": "GitHub Copilot",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  siliconflow: "SiliconFlow",
  "openai-compatible": "OpenAI-compatible",
};

/**
 * Short descriptors shown next to each Recommended provider name. The "More"
 * list intentionally hides descriptions to keep the row dense and scannable.
 */
const RECOMMENDED_DESCRIPTIONS: Partial<Record<ProviderId, string>> = {
  anthropic: "Claude family",
  openai: "GPT family",
  google: "Gemini family",
};

/** Stable 2-char glyph for a provider — same rule as `ByokGlobalTable`. */
function providerGlyph(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) {
    const w = words[0];
    return (w[0] + (w[1] ?? "")).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Look up the display name for a provider id; falls back to the id. */
function getDisplayName(id: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[id] ?? id;
}

/**
 * Returns true if `id` matches the search query — case-insensitive substring
 * match against both the display name and the id itself.
 */
function matchesQuery(id: ProviderId, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return getDisplayName(id).toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
}

export interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All providers currently in `settings.providers` — used to filter out. */
  existingProviders: ProviderConfig[];
  /** Called when the user picks a built-in provider row. */
  onPickBuiltin: (providerId: ProviderId) => void;
  /** Called when the user clicks "Add a custom provider". */
  onPickCustom: () => void;
}

/**
 * `AddProviderDialog` — see file header comment.
 */
export const AddProviderDialog: React.FC<AddProviderDialogProps> = ({
  open,
  onOpenChange,
  existingProviders,
  onPickBuiltin,
  onPickCustom,
}) => {
  const modalContainer = useTabOptional()?.modalContainer ?? null;
  const [query, setQuery] = useState("");

  const existingIds = useMemo<Set<ProviderId>>(
    () => new Set(existingProviders.map((p) => p.id)),
    [existingProviders]
  );

  const { recommended, more } = useMemo(() => {
    const recommended: ProviderId[] = RECOMMENDED_PROVIDER_IDS.filter(
      (id) => !existingIds.has(id) && matchesQuery(id, query)
    );
    const rest = SUPPORTED_PROVIDER_IDS.filter(
      (id) =>
        !RECOMMENDED_PROVIDER_IDS.includes(id) &&
        !EXCLUDED_FROM_MORE.has(id) &&
        !existingIds.has(id) &&
        matchesQuery(id, query)
    );
    // Alphabetical per §5.2 ("More providers — alphabetical").
    const more = rest.slice().sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b)));
    return { recommended, more };
  }, [existingIds, query]);

  const noMatches = recommended.length === 0 && more.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="tw-max-h-[80vh] tw-overflow-y-auto sm:tw-max-w-screen-sm"
        container={modalContainer}
      >
        <DialogHeader>
          <DialogTitle>Add a provider</DialogTitle>
          <DialogDescription>
            Pick a provider to configure, or bring your own endpoint as a custom provider.
          </DialogDescription>
        </DialogHeader>

        <div className="tw-flex tw-flex-col tw-gap-4">
          <SearchBar value={query} onChange={setQuery} placeholder="Search providers…" />

          {recommended.length > 0 && (
            <section data-testid="add-provider-recommended">
              <div className="tw-mb-2 tw-text-ui-smaller tw-font-medium tw-uppercase tw-tracking-wide tw-text-muted">
                Recommended
              </div>
              <div className="tw-flex tw-flex-col tw-gap-1">
                {recommended.map((id) => (
                  <RecommendedRow key={id} providerId={id} onClick={() => onPickBuiltin(id)} />
                ))}
              </div>
            </section>
          )}

          {more.length > 0 && (
            <section data-testid="add-provider-more">
              <div className="tw-mb-2 tw-text-ui-smaller tw-font-medium tw-uppercase tw-tracking-wide tw-text-muted">
                More providers
              </div>
              <div className="tw-flex tw-max-h-60 tw-flex-col tw-gap-0.5 tw-overflow-y-auto">
                {more.map((id) => (
                  <MoreProviderRow key={id} providerId={id} onClick={() => onPickBuiltin(id)} />
                ))}
              </div>
            </section>
          )}

          {noMatches && (
            <div className="tw-rounded-md tw-border tw-border-dashed tw-border-border tw-px-4 tw-py-6 tw-text-center tw-text-sm tw-text-muted">
              No providers match your search.
            </div>
          )}

          <button
            type="button"
            onClick={onPickCustom}
            data-testid="add-provider-custom-cta"
            className={cn(
              "tw-mt-2 tw-flex tw-w-full tw-cursor-pointer tw-flex-col tw-items-center tw-gap-1 tw-rounded-md",
              "tw-border tw-border-dashed tw-bg-interactive-accent/10 tw-border-interactive-accent/60",
              "tw-p-4 tw-text-center tw-text-sm tw-text-accent",
              "hover:tw-border-interactive-accent hover:tw-bg-interactive-accent/20"
            )}
          >
            <div className="tw-flex tw-items-center tw-gap-1.5 tw-font-medium">
              <Plus className="tw-size-4" />
              Add a custom provider
            </div>
            <div className="tw-text-ui-smaller tw-text-muted">
              Bring your own endpoint (OpenAI-compatible, Anthropic, or Google API).
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

interface ProviderRowProps {
  providerId: ProviderId;
  onClick: () => void;
}

/**
 * Provider glyph badge — small rounded square with 2 uppercase initials.
 */
const ProviderGlyph: React.FC<{ name: string; small?: boolean }> = ({ name, small }) => (
  <span
    aria-hidden
    className={cn(
      "tw-inline-flex tw-shrink-0 tw-items-center tw-justify-center tw-rounded-sm",
      "tw-bg-secondary-alt tw-font-medium tw-text-normal",
      small ? "tw-size-5 tw-text-ui-smaller" : "tw-size-6 tw-text-ui-smaller"
    )}
  >
    {providerGlyph(name)}
  </span>
);

/**
 * Recommended row: glyph + bold name + "— family" description + "Add →" pill.
 * The whole row is a single clickable button — clicking the pill or the row
 * both fire `onClick`.
 */
const RecommendedRow: React.FC<ProviderRowProps> = ({ providerId, onClick }) => {
  const name = getDisplayName(providerId);
  const description = RECOMMENDED_DESCRIPTIONS[providerId];
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`add-provider-card-${providerId}`}
      aria-label={`Add ${name} provider`}
      className={cn(
        "tw-group tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-gap-3 tw-rounded-md",
        "tw-border tw-border-solid tw-border-border tw-bg-primary tw-px-3 tw-py-2 tw-text-left",
        "hover:tw-border-interactive-accent hover:tw-bg-primary-alt/40"
      )}
    >
      <ProviderGlyph name={name} />
      <span className="tw-flex tw-min-w-0 tw-flex-1 tw-items-baseline tw-gap-1.5 tw-truncate">
        <span className="tw-truncate tw-text-sm tw-font-semibold tw-text-normal">{name}</span>
        {description && (
          <span className="tw-truncate tw-text-ui-smaller tw-text-muted">— {description}</span>
        )}
      </span>
      <span
        aria-hidden
        className={cn(
          "tw-inline-flex tw-shrink-0 tw-items-center tw-rounded-md tw-px-2 tw-py-1",
          "tw-bg-interactive-accent tw-text-ui-smaller tw-font-medium tw-text-on-accent",
          "group-hover:tw-bg-interactive-accent-hover"
        )}
      >
        Add →
      </span>
    </button>
  );
};

/**
 * More-providers row: smaller glyph + name + right-side "+" affordance. Tight
 * vertical padding so the alphabetical list stays scannable at scale.
 */
const MoreProviderRow: React.FC<ProviderRowProps> = ({ providerId, onClick }) => {
  const name = getDisplayName(providerId);
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`add-provider-card-${providerId}`}
      aria-label={`Add ${name} provider`}
      className={cn(
        "tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-gap-3 tw-rounded-md",
        "tw-border tw-border-solid tw-border-transparent tw-px-3 tw-py-1.5 tw-text-left",
        "hover:tw-border-border hover:tw-bg-primary-alt/40"
      )}
    >
      <ProviderGlyph name={name} small />
      <span className="tw-min-w-0 tw-flex-1 tw-truncate tw-text-sm tw-text-normal">{name}</span>
      <Plus
        aria-hidden
        className="tw-size-4 tw-shrink-0 tw-text-muted group-hover:tw-text-normal"
      />
    </button>
  );
};

AddProviderDialog.displayName = "AddProviderDialog";
