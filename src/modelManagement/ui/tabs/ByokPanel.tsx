/**
 * BYOK settings panel — the central registry UI.
 *
 * Lists every BYOK provider (origin `"byok"`) with its configured models,
 * and drives the add / configure / remove flows. Reactive reads come from
 * Jotai atoms; mutations go through `useModelManagement()`. The catalog is
 * loaded once on mount (disk cache, no network unless stale) and kept in
 * local state so it can be passed down to the Add Provider dialog.
 */
import { ConfirmModal } from "@/components/modals/ConfirmModal";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/ui/SearchBar";
import { useApp } from "@/context";
import { logError } from "@/logger";
import { byokProvidersAtom, configuredModelsAtom } from "@/modelManagement/state/atoms";
import type { CatalogProvider } from "@/modelManagement/types/catalog";
import type { ConfiguredModel } from "@/modelManagement/types/persisted";
import { useModelManagement } from "@/modelManagement/ui/ModelManagementContext";
import {
  ByokGlobalTable,
  type ByokTableGroup,
} from "@/modelManagement/ui/components/ByokGlobalTable";
import { AddProviderModal } from "@/modelManagement/ui/dialogs/AddProviderDialog";
import { ConfigureProviderModal } from "@/modelManagement/ui/dialogs/ConfigureProviderDialog";
import { settingsStore } from "@/settings/model";
import { useAtomValue } from "jotai";
import { Plus } from "lucide-react";
import { Notice } from "obsidian";
import React, { useEffect, useMemo, useState } from "react";

const EMPTY_CATALOG: readonly CatalogProvider[] = Object.freeze([]);
const EMPTY_MODELS: readonly ConfiguredModel[] = Object.freeze([]);

/**
 * `ByokPanel` — root component for the Models settings tab.
 */
export const ByokPanel: React.FC = () => {
  const api = useModelManagement();
  const app = useApp();

  const providers = useAtomValue(byokProvidersAtom, { store: settingsStore });
  const configuredModels = useAtomValue(configuredModelsAtom, { store: settingsStore });

  const [catalogProviders, setCatalogProviders] =
    useState<readonly CatalogProvider[]>(EMPTY_CATALOG);
  const [loadState, setLoadState] = useState<"loading" | "ready">("loading");
  const [query, setQuery] = useState("");

  // Load the catalog once and keep our snapshot in sync. The disk-load path
  // of `ensureLoaded` does NOT fire `onChange`, so we sync explicitly after
  // it resolves; `onChange` covers manual refreshes.
  useEffect(() => {
    let cancelled = false;
    const sync = (): void => {
      if (!cancelled) setCatalogProviders(api.catalogService.getAllProviders());
    };
    const unsub = api.catalogService.onChange(sync);
    api.catalogService
      .ensureLoaded()
      .then(() => {
        if (cancelled) return;
        sync();
        setLoadState("ready");
      })
      .catch((err) => {
        logError("[ByokPanel] catalog ensureLoaded failed", err);
        if (!cancelled) setLoadState("ready");
      });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [api]);

  const groups = useMemo<ByokTableGroup[]>(() => {
    const byProvider = new Map<string, ConfiguredModel[]>();
    for (const model of configuredModels) {
      const list = byProvider.get(model.providerId);
      if (list) list.push(model);
      else byProvider.set(model.providerId, [model]);
    }
    const q = query.trim().toLowerCase();
    return providers
      .map((provider) => {
        const all = byProvider.get(provider.providerId) ?? (EMPTY_MODELS as ConfiguredModel[]);
        if (!q || provider.displayName.toLowerCase().includes(q)) {
          return { provider, models: all };
        }
        const models = all.filter(
          (m) => m.info.displayName.toLowerCase().includes(q) || m.info.id.toLowerCase().includes(q)
        );
        return { provider, models };
      })
      .filter((g) => !q || g.models.length > 0 || g.provider.displayName.toLowerCase().includes(q));
  }, [providers, configuredModels, query]);

  const handleAddProvider = (): void => {
    new AddProviderModal(app, {
      catalogProviders,
      onPick: (catalog) =>
        new ConfigureProviderModal(app, { state: { mode: "new", catalog }, api }).open(),
    }).open();
  };

  const handleRemove = (providerId: string): void => {
    const provider = providers.find((p) => p.providerId === providerId);
    if (!provider) return;
    const modal = new ConfirmModal(
      app,
      async () => {
        try {
          await api.coordinator.removeProvider(providerId);
        } catch (err) {
          logError("[ByokPanel] removeProvider failed", err);
          new Notice("Failed to remove provider.");
        }
      },
      `Remove ${provider.displayName}? This also removes all of its models from every model picker.`,
      "Remove provider",
      "Remove",
      "Cancel"
    );
    modal.open();
  };

  return (
    <div className="tw-flex tw-flex-col tw-gap-4 tw-py-4">
      <div className="tw-flex tw-items-start tw-justify-between tw-gap-4">
        <div className="tw-flex tw-flex-col tw-gap-1">
          <div className="tw-text-base tw-font-semibold tw-text-normal">Bring Your Own Key</div>
          <div className="tw-max-w-xl tw-text-sm tw-text-muted">
            Set up your own providers and models to use in Copilot.
          </div>
        </div>
        <Button className="tw-shrink-0" onClick={handleAddProvider}>
          <Plus className="tw-size-4" />
          Add a provider
        </Button>
      </div>

      <SearchBar value={query} onChange={setQuery} placeholder="Search providers…" />

      <div className="tw-flex tw-flex-col">
        {loadState === "loading" ? (
          <div className="tw-text-sm tw-text-muted">Loading catalog…</div>
        ) : (
          <ByokGlobalTable
            groups={groups}
            emptyMessage={
              query.trim() && providers.length > 0 ? "No providers match your search." : undefined
            }
            onConfigure={(id) =>
              new ConfigureProviderModal(app, {
                state: { mode: "edit", providerId: id },
                api,
              }).open()
            }
            onRemove={handleRemove}
          />
        )}
      </div>
    </div>
  );
};
