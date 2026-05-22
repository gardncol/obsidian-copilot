/**
 * `ConfigureProviderDialog` — three-state dialog driving the BYOK provider
 * configuration UI.
 *
 * States (per §5.2):
 *   - `new-byok`   – first-time setup of a built-in provider (Anthropic, …).
 *   - `new-custom` – first-time setup of a user-defined endpoint.
 *   - `edit`       – modify an already-registered provider.
 *
 * Layout (abbreviated):
 *
 *   [An] Anthropic                                   ✓ Verified
 *   ──────────────────────────────────────────────────────────
 *   (new-custom only)
 *     Display name  [ … ]
 *     Type          (•) OpenAI-compatible (o) Anthropic (o) Google
 *   API key         [ ••••••••••••• ] [Test]
 *   Base URL        [ … ]   (editable in new-custom; read-only otherwise)
 *
 *   Models                       [+ Add from catalog] [+ Add custom model]
 *   [search] [All] [≥ 200k ctx] [≤ $1/M] [Released ≤ 6mo]
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ProviderCatalogList (rows of catalog models w/ release date col) │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   Footer:
 *     new-*: [Cancel] [Verify & save]    "N models selected"
 *     edit:  [Remove provider]           [Cancel] [Save changes]
 *
 * Caveats:
 *   - Capability checkboxes / availability rows are explicitly OUT (per
 *     redesign).
 *   - `[+ Add from catalog]` in edit state is a SCROLL-ONLY no-op — the
 *     model picker below already shows the full catalog with registered
 *     entries pre-checked, so a separate sub-modal would be redundant.
 *     Clicking the button just brings the list into view.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchBar } from "@/components/ui/SearchBar";
import { useTabOptional } from "@/contexts/TabContext";
import { cn } from "@/lib/utils";
import { logError } from "@/logger";
import { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService";
import type { CatalogModel } from "@/modelManagement/catalog/modelsCatalog.types";
import { defaultBaseUrl } from "@/modelManagement/providers/verifyProvider";
import type {
  ProviderConfig,
  ProviderId,
  RegistryEntry,
  VerificationResult,
} from "@/modelManagement/types";
import { ProviderCatalogList } from "@/modelManagement/ui/components/ProviderCatalogList";
import { AddCustomModelDialog } from "@/modelManagement/ui/dialogs/AddCustomModelDialog";
import { CheckCircle2, Loader2, Plus, XCircle } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

/** Custom-provider type discriminator surfaced to the user (radio group). */
type CustomProviderType = "openai-compatible" | "anthropic" | "google";

export type ConfigureProviderState = "new-byok" | "new-custom" | "edit";

/** Snapshot of the dialog's editable fields — passed to the save callbacks. */
export interface ConfigureProviderSavePayload {
  /** Resolved provider id (existing for edit; freshly minted for custom). */
  providerId: ProviderId;
  /** Final `ProviderConfig` to persist. */
  providerConfig: Omit<ProviderConfig, "addedAt"> & { addedAt?: number };
  /** Final list of `RegistryEntry`s (without `addedAt`) to bulk-set. */
  selectedEntries: Array<Omit<RegistryEntry, "addedAt">>;
}

export interface ConfigureProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConfigureProviderState;
  /**
   * - `new-byok`: provider id picked in `AddProviderDialog`. Required.
   * - `new-custom`: ignored (custom providers mint their own id).
   * - `edit`: existing provider id.
   */
  providerId?: ProviderId;
  /** Required in `edit` state. The dialog reads `displayName`, `apiKeyRef`, etc. */
  existingProvider?: ProviderConfig;
  /** Already-registered models for this provider (used to pre-check rows). */
  existingEntries?: RegistryEntry[];
  /** Static label used in the header for new-byok flows (no catalog hit). */
  builtinDisplayName?: string;
  /**
   * Test the current `(apiKey, baseUrl, extra)` triple against the
   * provider. Used by `[Test]`. Returning `ok: true` flips the verified
   * badge in edit state; failure decorates the row inline.
   */
  onTest: (draft: {
    providerId: ProviderId;
    apiKey: string;
    baseUrl?: string;
    extra?: Record<string, unknown>;
    type: ProviderConfig["type"];
  }) => Promise<VerificationResult>;
  /** Discover models from `<baseUrl>/models` for new-custom + openai-compat. */
  discoverModels?: (baseUrl: string, apiKey: string) => Promise<CatalogModel[]>;
  /** Ping a custom-added (provider, modelId) — wired through to AddCustomModelDialog. */
  onTestModel?: (providerId: ProviderId, modelId: string) => Promise<void>;
  /** Save callback — `add` for new-* states; `update` for edit. */
  onSave: (payload: ConfigureProviderSavePayload) => void | Promise<void>;
  /** Edit-only: remove the provider entirely. */
  onRemoveProvider?: (providerId: ProviderId) => void | Promise<void>;
  /** Catalog facade — defaulted to the singleton so tests can swap. */
  catalog?: Pick<ModelCatalogService, "getProvider" | "ensureLoaded">;
}

/**
 * Custom-provider id generator — `custom:<rfc4122-ish>`. We don't need
 * strong randomness for this; uniqueness within a vault is enough.
 */
function mintCustomProviderId(): ProviderId {
  // crypto.randomUUID() is available in modern Electron + jsdom 21+. We
  // gate behind a presence check to keep the function pure-ish for tests
  // that might run on older runtimes. Use `window.crypto` to satisfy the
  // popout-window lint that flags `globalThis` access.
  const cryptoLike: Crypto | undefined =
    typeof window !== "undefined" ? (window as { crypto?: Crypto }).crypto : undefined;
  if (cryptoLike?.randomUUID) {
    return `custom:${cryptoLike.randomUUID()}`;
  }
  // Fallback — sufficient for collision-avoidance within a single vault.
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve the type → ProviderConfig.type mapping for the custom radio.
 * (Identity mapping today — kept as a function so the layer is explicit.)
 */
function customTypeToProviderType(t: CustomProviderType): ProviderConfig["type"] {
  return t;
}

/**
 * Single 2-char glyph for a provider; copied from `ByokGlobalTable` to keep
 * the dialog's header visually consistent with the table.
 */
function providerGlyph(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) {
    const w = words[0];
    return (w[0] + (w[1] ?? "")).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * `ConfigureProviderDialog` — see file header comment for the full spec.
 */
export const ConfigureProviderDialog: React.FC<ConfigureProviderDialogProps> = ({
  open,
  onOpenChange,
  state,
  providerId,
  existingProvider,
  existingEntries,
  builtinDisplayName,
  onTest,
  discoverModels,
  onTestModel,
  onSave,
  onRemoveProvider,
  catalog,
}) => {
  const modalContainer = useTabOptional()?.modalContainer ?? null;
  const catalogSvc = catalog ?? ModelCatalogService.getInstance();

  // Form state — initialized lazily from the props relevant to each state.
  const [displayName, setDisplayName] = useState<string>(
    () => existingProvider?.displayName ?? builtinDisplayName ?? ""
  );
  const [apiKey, setApiKey] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>(() => existingProvider?.baseUrl ?? "");
  const [customType, setCustomType] = useState<CustomProviderType>("openai-compatible");
  const [extra, setExtra] = useState<Record<string, unknown>>(() => existingProvider?.extra ?? {});
  // For the API-key field: edit state masks the existing key (which lives
  // in the keychain or inline ref); typing replaces it. We track the
  // "user has typed" intent via a separate flag so we don't accidentally
  // wipe the key on save when they didn't touch the field.
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  // Selected catalog entries — `<providerId>:<modelId>`.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const e of existingEntries ?? []) {
      initial.add(`${e.providerId}:${e.modelId}`);
    }
    return initial;
  });

  // Verification UX — set after `[Test]` runs. Always starts `idle`, even
  // in edit; a historical `lastVerifiedAt` does NOT auto-credit. The user
  // re-tests on every session, which is what gates Save.
  const [verifyState, setVerifyState] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "verified"; verifiedAt: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Resets verification whenever the user touches a field that affects the
  // probe — keeps the Save gate honest.
  const clearVerify = (): void => setVerifyState({ kind: "idle" });

  // Discovered models for new-custom providers without a catalog entry.
  const [discoveredModels, setDiscoveredModels] = useState<CatalogModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Add-custom-model sub-dialog.
  const [addCustomModelOpen, setAddCustomModelOpen] = useState(false);
  // Locally-added custom registry entries (not in catalog) — surfaced
  // alongside catalog rows so the user sees the entries they just added.
  // On save we merge them into the bulk-set list.
  const [localCustomEntries, setLocalCustomEntries] = useState<
    Array<Omit<RegistryEntry, "addedAt">>
  >([]);

  // Filter bar state.
  const [query, setQuery] = useState("");

  // Reset form when the dialog reopens or state changes — avoids stale
  // values bleeding across edits of different providers.
  useEffect(() => {
    if (!open) return;
    setDisplayName(existingProvider?.displayName ?? builtinDisplayName ?? "");
    setBaseUrl(existingProvider?.baseUrl ?? "");
    setApiKey("");
    setApiKeyTouched(false);
    setExtra(existingProvider?.extra ?? {});
    setCustomType("openai-compatible");
    setSelectedIds(() => {
      const initial = new Set<string>();
      for (const e of existingEntries ?? []) {
        initial.add(`${e.providerId}:${e.modelId}`);
      }
      return initial;
    });
    setVerifyState({ kind: "idle" });
    setLocalCustomEntries([]);
    setDiscoveredModels([]);
    setDiscoveryError(null);
    setQuery("");
  }, [open, state, existingProvider, existingEntries, builtinDisplayName]);

  // Make sure the catalog is ready before we render the model picker.
  useEffect(() => {
    if (!open) return;
    void catalogSvc.ensureLoaded();
  }, [open, catalogSvc]);

  // Resolved id used by the model section / save payload. Custom providers
  // mint an id eagerly so `<providerId>:<modelId>` keys are stable across
  // toggles.
  const resolvedProviderId = useMemo<ProviderId | undefined>(() => {
    if (state === "edit") return existingProvider?.id ?? providerId;
    if (state === "new-byok") return providerId;
    // new-custom
    return undefined;
  }, [state, existingProvider, providerId]);

  // Custom providers need a stable id during the dialog session so checkbox
  // toggles work consistently. We assign one on first reveal.
  const [customId, setCustomId] = useState<ProviderId | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      setCustomId(undefined);
      return;
    }
    if (state === "new-custom" && !customId) {
      setCustomId(mintCustomProviderId());
    }
  }, [open, state, customId]);

  const effectiveProviderId = state === "new-custom" ? customId : resolvedProviderId;

  // Resolved provider type — drives the extras form and is forwarded to the
  // `[Test]`/save handlers. Single source of truth so the dialog can't
  // surface one type to the user and submit another.
  const effectiveType: ProviderConfig["type"] = useMemo(() => {
    if (state === "new-custom") return customTypeToProviderType(customType);
    return (
      existingProvider?.type ??
      (state === "new-byok" ? deriveBuiltinType(providerId) : "openai-compatible")
    );
  }, [state, customType, existingProvider, providerId]);

  // Decide which model list to show: discovered (new-custom + openai-compat)
  // OR catalog (built-in providers + edit state). Catalog lookup happens
  // inside the memo so `effectiveProviderId` is the only changing dep that
  // matters — see lint exhaustive-deps.
  const modelPool: CatalogModel[] = useMemo(() => {
    if (state === "new-custom" && customType === "openai-compatible") {
      return discoveredModels;
    }
    if (!effectiveProviderId) return [];
    const catalogProvider = catalogSvc.getProvider(effectiveProviderId);
    return catalogProvider ? Object.values(catalogProvider.models) : [];
  }, [state, customType, discoveredModels, catalogSvc, effectiveProviderId]);

  // Apply search query to the pool.
  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return modelPool;
    return modelPool.filter((model) => {
      const haystack = `${model.name} ${model.id}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [modelPool, query]);

  // Build a set of "selectedIds" lookups in the same `<providerId>:<modelId>`
  // shape `ProviderCatalogList` consumes.
  const localCustomKeys = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const e of localCustomEntries) {
      out.add(`${e.providerId}:${e.modelId}`);
    }
    return out;
  }, [localCustomEntries]);

  const registeredKeys = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const e of existingEntries ?? []) {
      out.add(`${e.providerId}:${e.modelId}`);
    }
    return out;
  }, [existingEntries]);

  const toggleModel = (modelId: string): void => {
    if (!effectiveProviderId) return;
    const key = `${effectiveProviderId}:${modelId}`;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleTest = async (): Promise<void> => {
    if (!effectiveProviderId) return;
    setVerifyState({ kind: "testing" });
    try {
      const result = await onTest({
        providerId: effectiveProviderId,
        apiKey,
        baseUrl: baseUrl || undefined,
        extra,
        type: effectiveType,
      });
      if (result.ok) {
        setVerifyState({ kind: "verified", verifiedAt: result.verifiedAt });
      } else {
        setVerifyState({ kind: "error", message: result.error ?? "Unknown error" });
      }
    } catch (err) {
      logError("[ConfigureProviderDialog] Verify threw:", err);
      const message = err instanceof Error ? err.message : String(err);
      setVerifyState({ kind: "error", message });
    }
  };

  const handleDiscover = async (): Promise<void> => {
    if (!discoverModels || !baseUrl.trim()) return;
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const models = await discoverModels(baseUrl.trim(), apiKey);
      setDiscoveredModels(models);
    } catch (err) {
      logError("[ConfigureProviderDialog] Discovery failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      setDiscoveryError(message);
      setDiscoveredModels([]);
    } finally {
      setDiscovering(false);
    }
  };

  const handleAddCustomModel = (entry: Omit<RegistryEntry, "addedAt">): void => {
    setLocalCustomEntries((prev) => [...prev, entry]);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.add(`${entry.providerId}:${entry.modelId}`);
      return next;
    });
  };

  const handleSave = async (): Promise<void> => {
    if (!effectiveProviderId) return;

    const kind: ProviderConfig["kind"] = state === "new-custom" ? "custom" : "builtin";
    const type = effectiveType;

    // Resolve `apiKeyRef`:
    //   - touched + non-empty: store inline (keychain promotion happens later).
    //   - touched + empty: clear the ref.
    //   - untouched: preserve existing.
    let apiKeyRef: ProviderConfig["apiKeyRef"];
    if (apiKeyTouched) {
      apiKeyRef = apiKey.trim() ? { kind: "inline", value: apiKey.trim() } : null;
    } else {
      apiKeyRef = existingProvider?.apiKeyRef;
    }

    const finalProvider: Omit<ProviderConfig, "addedAt"> = {
      id: effectiveProviderId,
      kind,
      displayName: displayName.trim() || builtinDisplayName || effectiveProviderId,
      type,
      baseUrl: baseUrl.trim() || undefined,
      apiKeyRef,
      extra,
    };
    // Edit state — surface the verified-at timestamp when verification was
    // re-run during this session.
    if (verifyState.kind === "verified") {
      (finalProvider as ProviderConfig).lastVerifiedAt = verifyState.verifiedAt;
    }

    // Compose the registry-entry list. Catalog rows that are still checked
    // produce one entry each; local custom entries are appended verbatim if
    // their key is still selected.
    const selectedFromCatalog: Array<Omit<RegistryEntry, "addedAt">> = [];
    const pool = modelPool;
    for (const model of pool) {
      const key = `${effectiveProviderId}:${model.id}`;
      if (!selectedIds.has(key)) continue;
      if (localCustomKeys.has(key)) continue; // handled below
      selectedFromCatalog.push({
        providerId: effectiveProviderId,
        modelId: model.id,
        displayName: model.name,
      });
    }
    // Preserve registered models that aren't currently in the pool (e.g.
    // discovered list shrank, or filter chip hid them) — we never want a
    // save to silently drop entries the user didn't touch.
    for (const entry of existingEntries ?? []) {
      const key = `${entry.providerId}:${entry.modelId}`;
      if (!selectedIds.has(key)) continue;
      if (selectedFromCatalog.some((e) => e.modelId === entry.modelId)) continue;
      if (localCustomKeys.has(key)) continue;
      selectedFromCatalog.push({
        providerId: effectiveProviderId,
        modelId: entry.modelId,
        displayName: entry.displayName,
      });
    }
    const localStillSelected = localCustomEntries.filter((e) =>
      selectedIds.has(`${effectiveProviderId}:${e.modelId}`)
    );
    const selectedEntries = [...selectedFromCatalog, ...localStillSelected];

    await onSave({
      providerId: effectiveProviderId,
      providerConfig: finalProvider,
      selectedEntries,
    });
    onOpenChange(false);
  };

  const handleRemoveProvider = async (): Promise<void> => {
    if (state !== "edit" || !existingProvider || !onRemoveProvider) return;
    await onRemoveProvider(existingProvider.id);
    onOpenChange(false);
  };

  const dialogTitle = (
    <div className="tw-flex tw-items-center tw-gap-2">
      <span
        aria-hidden
        className={cn(
          "tw-inline-flex tw-size-6 tw-items-center tw-justify-center tw-rounded-sm",
          "tw-bg-secondary-alt tw-text-ui-smaller tw-font-medium tw-text-normal"
        )}
      >
        {providerGlyph(displayName || builtinDisplayName || "??")}
      </span>
      <span>{titleForState(state, displayName, builtinDisplayName)}</span>
      {state === "edit" && verifyState.kind === "verified" && (
        <Badge variant="outline" className="tw-text-success" data-testid="configure-verified">
          <CheckCircle2 className="tw-mr-1 tw-size-3.5" /> Verified
        </Badge>
      )}
    </div>
  );

  const filteredSelectedCount = Array.from(selectedIds).filter((k) =>
    k.startsWith(`${effectiveProviderId}:`)
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="tw-flex tw-max-h-[85vh] tw-flex-col tw-gap-3 tw-overflow-hidden sm:tw-max-w-[720px]"
        container={modalContainer}
        data-testid={`configure-provider-${state}`}
      >
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Configure the connection and pick which models surface in your registry.
          </DialogDescription>
        </DialogHeader>

        <div className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col tw-gap-4 tw-overflow-y-auto">
          {state === "new-custom" && (
            <section className="tw-flex tw-flex-col tw-gap-3" data-testid="configure-custom-extras">
              <FormField label="Display name" required>
                <Input
                  type="text"
                  placeholder="Local Ollama"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  data-testid="configure-display-name"
                />
              </FormField>
              <FormField label="Type">
                <div
                  className="tw-flex tw-items-center tw-gap-4"
                  role="radiogroup"
                  aria-label="Custom provider type"
                >
                  {(["openai-compatible", "anthropic", "google"] as CustomProviderType[]).map(
                    (t) => (
                      <label
                        key={t}
                        className="tw-flex tw-cursor-pointer tw-items-center tw-gap-2 tw-text-sm"
                      >
                        <input
                          type="radio"
                          name="custom-provider-type"
                          value={t}
                          checked={customType === t}
                          onChange={() => {
                            setCustomType(t);
                            clearVerify();
                          }}
                          data-testid={`configure-type-${t}`}
                        />
                        {labelForCustomType(t)}
                      </label>
                    )
                  )}
                </div>
              </FormField>
            </section>
          )}

          <section className="tw-flex tw-flex-col tw-gap-3" data-testid="configure-connection">
            <FormField
              label={
                <div className="tw-flex tw-items-center tw-gap-2">
                  <span>API key</span>
                  {verifyState.kind === "verified" && (
                    <span className="tw-text-xs tw-text-success" aria-label="verified">
                      ✓
                    </span>
                  )}
                  {verifyState.kind === "error" && (
                    <span className="tw-text-xs tw-text-error" aria-label="error">
                      ⚠
                    </span>
                  )}
                </div>
              }
            >
              <div className="tw-flex tw-gap-2">
                <Input
                  type="password"
                  className="tw-flex-1 tw-font-mono"
                  placeholder={
                    state === "edit" && existingProvider?.apiKeyRef
                      ? "•••••••••••••• (stored)"
                      : "Paste API key"
                  }
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setApiKeyTouched(true);
                    clearVerify();
                  }}
                  data-testid="configure-api-key"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTest}
                  disabled={verifyState.kind === "testing"}
                  data-testid="configure-test-key"
                >
                  {verifyState.kind === "testing" ? (
                    <>
                      <Loader2 className="tw-size-3.5 tw-animate-spin" />
                      Test
                    </>
                  ) : (
                    "Test"
                  )}
                </Button>
              </div>
              {verifyState.kind === "error" && (
                <p
                  className="tw-mt-1 tw-flex tw-items-start tw-gap-1.5 tw-text-xs tw-text-error"
                  data-testid="configure-test-error"
                >
                  <XCircle className="tw-mt-0.5 tw-size-3.5 tw-shrink-0" />
                  {verifyState.message}
                </p>
              )}
              {state === "edit" &&
                existingProvider?.lastVerifiedAt &&
                verifyState.kind === "idle" && (
                  <p
                    className="tw-mt-1 tw-text-xs tw-text-muted"
                    data-testid="configure-last-verified"
                  >
                    Last verified {formatRelativeTime(existingProvider.lastVerifiedAt)} — re-test to
                    enable save.
                  </p>
                )}
            </FormField>

            <FormField label="Base URL">
              <div className="tw-flex tw-gap-2">
                <Input
                  type="text"
                  className="tw-flex-1"
                  placeholder={baseUrlPlaceholder(state, effectiveProviderId)}
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    clearVerify();
                  }}
                  data-testid="configure-base-url"
                />
                {state === "new-custom" && customType === "openai-compatible" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleDiscover}
                    disabled={!baseUrl.trim() || discovering}
                    data-testid="configure-discover"
                  >
                    {discovering ? (
                      <>
                        <Loader2 className="tw-size-3.5 tw-animate-spin" />
                        Discover
                      </>
                    ) : (
                      "Discover"
                    )}
                  </Button>
                )}
              </div>
              {discoveryError && (
                <p className="tw-mt-1 tw-text-xs tw-text-error">{discoveryError}</p>
              )}
            </FormField>

            <ProviderExtrasForm
              providerType={effectiveType}
              providerId={effectiveProviderId}
              extra={extra}
              setExtra={(next) => {
                setExtra(next);
                clearVerify();
              }}
            />

            {/* No Availability row — explicitly removed per redesign. */}
          </section>

          {/* Models section */}
          <section className="tw-flex tw-flex-col tw-gap-2" data-testid="configure-models-section">
            <div className="tw-flex tw-items-center tw-justify-between">
              <Label className="tw-text-sm tw-font-medium">Models</Label>
              <div className="tw-flex tw-items-center tw-gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAddCustomModelOpen(true)}
                  disabled={!effectiveProviderId}
                  data-testid="configure-add-custom-model"
                >
                  <Plus className="tw-size-3.5" />
                  Add custom model
                </Button>
              </div>
            </div>

            <div className="tw-flex tw-flex-wrap tw-items-center tw-gap-2">
              <div className="tw-min-w-48 tw-flex-1">
                <SearchBar value={query} onChange={setQuery} placeholder="Filter models…" />
              </div>
            </div>

            {effectiveProviderId ? (
              <ProviderCatalogList
                providerId={effectiveProviderId}
                models={filteredModels}
                selectedModelIds={selectedIds}
                onToggle={toggleModel}
                showKebab={state === "edit"}
                registeredModelIds={registeredKeys}
                onRemoveFromRegistry={(modelId) => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    next.delete(`${effectiveProviderId}:${modelId}`);
                    return next;
                  });
                }}
                emptyMessage={
                  state === "new-custom" && customType === "openai-compatible"
                    ? "Discover models via the [Discover] button after entering a base URL, or use [+ Add custom model]."
                    : undefined
                }
              />
            ) : (
              <div className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-p-4 tw-text-center tw-text-sm tw-text-muted">
                Pick a provider to see its models.
              </div>
            )}

            {localCustomEntries.length > 0 && (
              <div
                className="tw-mt-2 tw-rounded-md tw-border tw-border-solid tw-border-border tw-p-2 tw-bg-primary-alt/30"
                data-testid="configure-local-custom"
              >
                <div className="tw-mb-1 tw-text-ui-smaller tw-font-medium tw-text-muted">
                  Just added
                </div>
                {localCustomEntries.map((entry) => (
                  <div
                    key={entry.modelId}
                    className="tw-flex tw-items-center tw-gap-2 tw-py-1 tw-text-sm"
                  >
                    <span className="tw-flex-1 tw-truncate">{entry.displayName}</span>
                    <Badge variant="outline" className="tw-text-ui-smaller">
                      custom
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="tw-flex tw-items-center tw-justify-between tw-gap-2">
          {state === "edit" ? (
            <>
              <Button
                variant="destructive"
                onClick={handleRemoveProvider}
                data-testid="configure-remove-provider"
              >
                Remove provider
              </Button>
              <div className="tw-flex tw-items-center tw-gap-2">
                <Button variant="secondary" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  onClick={handleSave}
                  disabled={!effectiveProviderId || verifyState.kind !== "verified"}
                  title={
                    verifyState.kind === "verified"
                      ? undefined
                      : "Run a successful Test before saving."
                  }
                  data-testid="configure-save"
                >
                  Save changes
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="tw-text-xs tw-text-muted" data-testid="configure-selected-count">
                {filteredSelectedCount} model{filteredSelectedCount === 1 ? "" : "s"} selected
              </div>
              <div className="tw-flex tw-items-center tw-gap-2">
                <Button variant="secondary" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  onClick={handleSave}
                  disabled={!effectiveProviderId || verifyState.kind !== "verified"}
                  title={
                    verifyState.kind === "verified"
                      ? undefined
                      : "Run a successful Test before saving."
                  }
                  data-testid="configure-verify-save"
                >
                  Save
                </Button>
              </div>
            </>
          )}
        </div>

        {effectiveProviderId && (
          <AddCustomModelDialog
            open={addCustomModelOpen}
            onOpenChange={setAddCustomModelOpen}
            provider={{
              id: effectiveProviderId,
              kind: state === "new-custom" ? "custom" : "builtin",
              displayName: displayName || builtinDisplayName || effectiveProviderId,
              type: effectiveType,
              baseUrl: baseUrl || undefined,
              apiKeyRef: existingProvider?.apiKeyRef ?? null,
              extra,
              addedAt: existingProvider?.addedAt ?? Date.now(),
            }}
            onTest={async (modelId) => {
              if (!onTestModel || !effectiveProviderId) return;
              await onTestModel(effectiveProviderId, modelId);
            }}
            onAdd={handleAddCustomModel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * Resolve the placeholder shown in the Base URL field. New-custom flows hint
 * at a local endpoint; known built-ins surface their canonical URL so the
 * user can see where requests will actually land. Unknown providers fall
 * back to a generic "leave blank" cue.
 */
function baseUrlPlaceholder(
  state: ConfigureProviderState,
  providerId: ProviderId | undefined
): string {
  if (state === "new-custom") return "http://localhost:11434/v1";
  const known = providerId ? defaultBaseUrl(providerId) : undefined;
  return known ?? "Default endpoint (leave blank)";
}

interface ProviderExtrasFormProps {
  providerType: ProviderConfig["type"];
  providerId: ProviderId | undefined;
  extra: Record<string, unknown>;
  setExtra: (next: Record<string, unknown>) => void;
}

/**
 * Typed inputs for the subset of `ProviderConfig.extra` fields that affect
 * the verification probe / HTTP destination. Renders nothing for provider
 * types whose adapters declare no extras (anthropic, google, …).
 */
const ProviderExtrasForm: React.FC<ProviderExtrasFormProps> = ({
  providerType,
  providerId,
  extra,
  setExtra,
}) => {
  const update = (key: string, value: string): void => {
    const next = { ...extra };
    if (value.trim()) next[key] = value;
    else delete next[key];
    setExtra(next);
  };
  const read = (key: string): string => {
    const v = extra[key];
    return typeof v === "string" ? v : "";
  };

  if (providerType === "azure") {
    return (
      <div className="tw-flex tw-flex-col tw-gap-3" data-testid="configure-extras-azure">
        <FormField label="Azure instance" required>
          <Input
            type="text"
            placeholder="myinstance"
            value={read("azureInstanceName")}
            onChange={(e) => update("azureInstanceName", e.target.value)}
            data-testid="configure-extra-azure-instance"
          />
        </FormField>
        <FormField label="Azure deployment" required>
          <Input
            type="text"
            placeholder="my-deployment"
            value={read("azureDeploymentName")}
            onChange={(e) => update("azureDeploymentName", e.target.value)}
            data-testid="configure-extra-azure-deployment"
          />
        </FormField>
        <FormField label="Azure API version" required>
          <Input
            type="text"
            placeholder="2024-05-01-preview"
            value={read("azureApiVersion")}
            onChange={(e) => update("azureApiVersion", e.target.value)}
            data-testid="configure-extra-azure-version"
          />
        </FormField>
      </div>
    );
  }

  if (providerType === "bedrock") {
    return (
      <FormField label="AWS region">
        <Input
          type="text"
          placeholder="us-east-1"
          value={read("bedrockRegion")}
          onChange={(e) => update("bedrockRegion", e.target.value)}
          data-testid="configure-extra-bedrock-region"
        />
      </FormField>
    );
  }

  if (providerType === "openai-compatible" && providerId === "openai") {
    return (
      <FormField label="OpenAI organization ID">
        <Input
          type="text"
          placeholder="org-…"
          value={read("openAIOrgId")}
          onChange={(e) => update("openAIOrgId", e.target.value)}
          data-testid="configure-extra-openai-org"
        />
      </FormField>
    );
  }

  return null;
};

/**
 * Compact relative-time formatter (e.g. "3 days ago"). Used only for the
 * historic `lastVerifiedAt` helper text. Falls back to a localized date
 * string for spans beyond 60 days.
 */
function formatRelativeTime(epochMillis: number): string {
  const diffSec = (epochMillis - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  if (abs < 60 * 60) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 60 * 60 * 24) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 60 * 60 * 24 * 60) return rtf.format(Math.round(diffSec / 86_400), "day");
  return new Date(epochMillis).toLocaleDateString();
}

/**
 * Resolve a built-in provider id → `ProviderConfig.type`. Keeps the dialog
 * decoupled from the rest of the adapter registry.
 */
function deriveBuiltinType(providerId: ProviderId | undefined): ProviderConfig["type"] {
  switch (providerId) {
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "azure":
      return "azure";
    case "amazon-bedrock":
      return "bedrock";
    case "github-copilot":
      return "github-copilot";
    default:
      return "openai-compatible";
  }
}

/** Pretty-print the radio label — exposed as a function for testability. */
function labelForCustomType(t: CustomProviderType): string {
  switch (t) {
    case "openai-compatible":
      return "OpenAI-compatible";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
  }
}

/** Dialog title text per state. */
function titleForState(
  state: ConfigureProviderState,
  displayName: string,
  builtinName: string | undefined
): string {
  const name = displayName || builtinName || "Provider";
  if (state === "new-byok") return `Add ${name}`;
  if (state === "new-custom") return "Add custom provider";
  return `Configure ${name}`;
}

ConfigureProviderDialog.displayName = "ConfigureProviderDialog";
