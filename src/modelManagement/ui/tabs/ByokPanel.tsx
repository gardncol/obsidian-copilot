/**
 * BYOK settings panel — the central registry UI.
 *
 * Threads the Obsidian {@link App} in via props rather than reading the
 * global, for popout-window safety and testability.
 */
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/ui/SearchBar";
import { cn } from "@/lib/utils";
import { logError, logInfo } from "@/logger";
import { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService";
import { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";
import { verifyProvider } from "@/modelManagement/providers/verifyProvider";
import { ModelRegistry } from "@/modelManagement/registry/ModelRegistry";
import type { ProviderConfig, ProviderId, RegistryEntry } from "@/modelManagement/types";
import {
  ByokGlobalTable,
  type ByokTableProviderGroup,
} from "@/modelManagement/ui/components/ByokGlobalTable";
import { AddProviderDialog } from "@/modelManagement/ui/dialogs/AddProviderDialog";
import {
  ConfigureProviderDialog,
  type ConfigureProviderState,
  type ConfigureProviderSavePayload,
} from "@/modelManagement/ui/dialogs/ConfigureProviderDialog";
import { App, Notice, Platform } from "obsidian";
import { Plus } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

/** 24 hours in millis — see §5.1 stale-refresh trigger. */
const STALE_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface ByokPanelProps {
  /**
   * Obsidian {@link App} — required for opening confirm modals. Threaded
   * through React props from `SettingsMainV2` so we never reach for the
   * global `app` (popout-window safety + testability).
   */
  app: App;
}

/**
 * `ByokPanel` — the central BYOK tab.
 */
export const ByokPanel: React.FC<ByokPanelProps> = ({ app }) => {
  const catalog = ModelCatalogService.getInstance();
  const providerRegistry = ProviderRegistry.getInstance();
  const modelRegistry = ModelRegistry.getInstance();

  const [loadState, setLoadState] = useState<"loading" | "ready">("loading");
  // Filter out `kind: "system"` providers (e.g. `opencode`, `copilot-plus`).
  // System providers exist in `settings.providers` so the RegistryEntry FK
  // invariant holds, but they're credentialed by their agent backend — there's
  // no API key, base URL, or per-model toggle the user can configure here.
  // Showing them in the BYOK tab would be confusing and offer no actions.
  const [providers, setProviders] = useState<ProviderConfig[]>(() =>
    providerRegistry.list().filter((p) => p.kind !== "system")
  );
  const [registry, setRegistry] = useState<RegistryEntry[]>(() => modelRegistry.list());
  const [query, setQuery] = useState("");

  // Dialog state — keeps the picker/configure flow local to the panel so
  // SettingsMainV2 doesn't have to know about the model-management modals.
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  // `null` = dialog closed; otherwise we're in the matching state.
  const [configureState, setConfigureState] = useState<{
    state: ConfigureProviderState;
    providerId?: ProviderId;
    builtinDisplayName?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalog
      .ensureLoaded()
      .then(() => {
        if (cancelled) return;
        setLoadState("ready");
        // Background refresh if stale.
        const meta = catalog.getMeta();
        const now = Date.now();
        if (!meta.fetchedAt || now - meta.fetchedAt > STALE_REFRESH_THRESHOLD_MS) {
          // Fire-and-forget — surface errors via logging only.
          catalog
            .refresh()
            .then((result) => {
              if (!result.ok) {
                logInfo("[ByokPanel] Background refresh skipped:", result.error);
              }
            })
            .catch((err) => logError("[ByokPanel] Background refresh failed:", err));
        }
      })
      .catch((err) => {
        logError("[ByokPanel] ensureLoaded failed:", err);
        if (!cancelled) setLoadState("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  // Subscribe to provider / model registry mutations.
  useEffect(() => {
    const unsubProviders = providerRegistry.onChange(() => {
      // Same `kind !== "system"` filter as the initial-state read above.
      setProviders(providerRegistry.list().filter((p) => p.kind !== "system"));
    });
    const unsubRegistry = modelRegistry.onChange(() => {
      setRegistry(modelRegistry.list());
    });
    return () => {
      unsubProviders();
      unsubRegistry();
    };
  }, [providerRegistry, modelRegistry]);

  const groups = useMemo<ByokTableProviderGroup[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return providers
      .map((provider) => {
        const entries = registry.filter((entry) => {
          if (entry.providerId !== provider.id) return false;
          if (normalizedQuery) {
            const haystack = `${entry.displayName} ${entry.modelId}`.toLowerCase();
            if (!haystack.includes(normalizedQuery)) return false;
          }
          return true;
        });
        if (entries.length === 0) {
          return { provider, entries, hidden: true };
        }
        return { provider, entries, hidden: false };
      })
      .filter((g): g is ByokTableProviderGroup & { hidden: false } => !g.hidden)
      .map(({ provider, entries }) => ({ provider, entries }));
  }, [providers, registry, query]);

  /** Open the Configure dialog in edit-state for the given provider. */
  const handleConfigureProvider = (providerId: ProviderId): void => {
    const provider = providerRegistry.get(providerId);
    if (!provider) return;
    setConfigureState({ state: "edit", providerId });
  };

  /**
   * Common save handler used by the Configure dialog in all three states.
   * Replaces the provider config + bulk-sets the registry entries.
   */
  const handleSaveProvider = async (payload: ConfigureProviderSavePayload): Promise<void> => {
    try {
      const existing = providerRegistry.get(payload.providerId);
      if (existing) {
        await providerRegistry.update(payload.providerId, payload.providerConfig);
      } else {
        await providerRegistry.add(payload.providerConfig);
      }
      await modelRegistry.bulkSet(
        payload.providerId,
        payload.selectedEntries.map((e) => ({ ...e, addedAt: Date.now() }))
      );
      logInfo(
        `[ByokPanel] Saved provider ${payload.providerId} with ${payload.selectedEntries.length} model(s).`
      );
    } catch (err) {
      logError("[ByokPanel] Save provider failed:", err);
      new Notice("Failed to save provider. See console for details.");
    }
  };

  /**
   * `[Test]` verifier — calls `verifyProvider` to make a real HTTP probe.
   * In edit state, the dialog leaves `apiKey` blank when the user hasn't
   * touched the field, so we substitute the stored credential before
   * dispatching.
   */
  const handleTestKey: React.ComponentProps<typeof ConfigureProviderDialog>["onTest"] = async (
    draft
  ) => {
    let apiKey = draft.apiKey;
    if (!apiKey.trim()) {
      const stored = await providerRegistry.getApiKey(draft.providerId);
      if (stored) apiKey = stored;
    }
    return verifyProvider({ ...draft, apiKey });
  };

  /**
   * `discoverModels` against an OpenAI-compatible `<baseUrl>/models`. The
   * implementation lives here (vs the dialog) so the dialog stays
   * presentation-only and we can test the parser independently if needed.
   */
  const handleDiscoverModels: React.ComponentProps<
    typeof ConfigureProviderDialog
  >["discoverModels"] = async (baseUrl, apiKey) => {
    const normalized = baseUrl.replace(/\/$/, "");
    const url = `${normalized}/models`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (payload.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // Map back to a minimal CatalogModel shape so the existing picker can
    // render the rows without a separate code path.
    return ids.map((id) => ({
      id,
      name: id,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 0, output: 0 },
    }));
  };

  /**
   * Per-model `[Test]` — reduces to a provider-account check. The HTTP probe
   * validates the key against the provider, not a specific model; once the
   * key works, the user can choose any model they have access to.
   */
  const handleTestModel: React.ComponentProps<
    typeof ConfigureProviderDialog
  >["onTestModel"] = async (providerId, modelId) => {
    const provider = providerRegistry.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider '${providerId}'`);
    }
    const apiKey = (await providerRegistry.getApiKey(providerId)) ?? "";
    const result = await verifyProvider({
      providerId,
      apiKey,
      baseUrl: provider.baseUrl,
      extra: provider.extra,
      type: provider.type,
    });
    if (!result.ok) {
      throw new Error(result.error ?? `Test failed for ${modelId}`);
    }
  };

  const handleRemoveProvider = (providerId: string): void => {
    const provider = providerRegistry.get(providerId);
    if (!provider) return;
    // Lazy require so the BYOK barrel doesn't pull obsidian.Modal at module
    // evaluation time — that would break the deep-dependency-chain test
    // suites that mock `obsidian` without exporting Modal. See AGENTS.md
    // §"Avoiding Deep Dependency Chains".
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConfirmModal } = require("@/components/modals/ConfirmModal") as {
      ConfirmModal: new (
        app: App,
        onConfirm: () => void | Promise<void>,
        content: string,
        title: string,
        confirmButtonText?: string,
        cancelButtonText?: string
      ) => { open: () => void };
    };
    const modal = new ConfirmModal(
      app,
      async () => {
        try {
          await providerRegistry.remove(providerId);
        } catch (err) {
          logError("[ByokPanel] Remove provider failed:", err);
          new Notice("Failed to remove provider");
        }
      },
      `Remove ${provider.displayName}? This will also remove all of its registered models.`,
      "Remove provider",
      "Remove",
      "Cancel"
    );
    modal.open();
  };

  if (loadState === "loading") {
    return <ByokSkeleton />;
  }

  const isMobile = Platform.isMobile;

  const headerActions = (
    <div
      className={cn(
        "tw-flex tw-gap-2",
        isMobile ? "tw-flex-col tw-items-stretch" : "tw-flex-row tw-items-center"
      )}
    >
      <Button
        variant="default"
        size="sm"
        onClick={() => setAddProviderOpen(true)}
        data-testid="byok-add-provider"
      >
        <Plus className="tw-size-3.5" />
        Add provider
      </Button>
    </div>
  );

  const configureDialog = configureState && (
    <ConfigureProviderDialog
      open={true}
      onOpenChange={(next) => {
        if (!next) setConfigureState(null);
      }}
      state={configureState.state}
      providerId={configureState.providerId}
      existingProvider={
        configureState.state === "edit" && configureState.providerId
          ? providerRegistry.get(configureState.providerId)
          : undefined
      }
      existingEntries={
        configureState.providerId
          ? modelRegistry.list({ providerId: configureState.providerId })
          : []
      }
      builtinDisplayName={configureState.builtinDisplayName}
      onTest={handleTestKey}
      discoverModels={handleDiscoverModels}
      onTestModel={handleTestModel}
      onSave={handleSaveProvider}
      onRemoveProvider={async (id) => {
        await providerRegistry.remove(id);
      }}
    />
  );

  const dialogs = (
    <>
      <AddProviderDialog
        open={addProviderOpen}
        onOpenChange={setAddProviderOpen}
        existingProviders={providers}
        onPickBuiltin={(id) => {
          setAddProviderOpen(false);
          setConfigureState({
            state: "new-byok",
            providerId: id,
            builtinDisplayName: catalog.getProvider(id)?.name ?? id,
          });
        }}
        onPickCustom={() => {
          setAddProviderOpen(false);
          setConfigureState({ state: "new-custom" });
        }}
      />
      {configureDialog}
    </>
  );

  if (providers.length === 0) {
    return (
      <div className="tw-flex tw-flex-col tw-gap-4 tw-py-6">
        <ByokDescription />
        <div className="tw-flex tw-justify-center tw-py-12">
          <div
            className={cn(
              "tw-flex tw-w-full tw-max-w-md tw-flex-col tw-items-center tw-gap-3 tw-rounded-md",
              "tw-border tw-border-dashed tw-border-border tw-p-8 tw-text-center tw-bg-primary-alt/30"
            )}
          >
            <div className="tw-text-sm tw-text-muted">No providers configured yet.</div>
            <Button
              variant="default"
              onClick={() => setAddProviderOpen(true)}
              data-testid="byok-add-provider-empty"
            >
              <Plus className="tw-size-4" />
              Add provider
            </Button>
          </div>
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="tw-flex tw-flex-col tw-gap-4 tw-py-4">
      <div
        className={cn(
          "tw-flex tw-gap-3",
          isMobile
            ? "tw-flex-col tw-items-stretch"
            : "tw-flex-row tw-items-start tw-justify-between"
        )}
      >
        <div className="tw-flex tw-flex-col tw-gap-1">
          <div className="tw-text-base tw-font-semibold tw-text-normal">BYOK</div>
          <ByokDescription />
        </div>
        {headerActions}
      </div>
      <FilterBar query={query} setQuery={setQuery} />
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={handleConfigureProvider}
        onRemoveProvider={handleRemoveProvider}
      />
      {dialogs}
    </div>
  );
};

const ByokDescription: React.FC = () => (
  <div className="tw-max-w-xl tw-text-sm tw-text-muted">
    Bring your own providers and models to use in Copilot.
  </div>
);

/** Skeleton used while `ensureLoaded()` is in flight. */
const ByokSkeleton: React.FC = () => (
  <div className="tw-flex tw-flex-col tw-gap-3 tw-py-6" data-testid="byok-skeleton">
    <div className="tw-h-4 tw-w-32 tw-animate-pulse tw-rounded-sm tw-bg-secondary-alt" />
    <div className="tw-h-3 tw-w-full tw-animate-pulse tw-rounded-sm tw-bg-secondary-alt" />
    <div className="tw-h-3 tw-w-3/4 tw-animate-pulse tw-rounded-sm tw-bg-secondary-alt" />
    <div className="tw-mt-3 tw-h-24 tw-w-full tw-animate-pulse tw-rounded-sm tw-bg-secondary-alt" />
  </div>
);

interface FilterBarProps {
  query: string;
  setQuery: (q: string) => void;
}

const FilterBar: React.FC<FilterBarProps> = ({ query, setQuery }) => (
  <div className="tw-flex tw-flex-wrap tw-items-center tw-gap-2">
    <div className="tw-min-w-48 tw-flex-1">
      <SearchBar value={query} onChange={setQuery} placeholder="Filter models…" />
    </div>
  </div>
);
