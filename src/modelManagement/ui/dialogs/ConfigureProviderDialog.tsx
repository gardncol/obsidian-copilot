/**
 * `ConfigureProviderModal` — credentials + model selection for a BYOK
 * provider. Two modes:
 *   - `new`:  the user just picked a catalog provider in AddProviderModal.
 *             Nothing is persisted until "Verify & save".
 *   - `edit`: re-open an existing provider to change its name / key / base
 *             URL / model selection, or remove it.
 *
 * Hosted in a native Obsidian `Modal`. `ConfigureProviderForm` is the pure
 * body (exported for unit tests); it reads provider + model rows from Jotai
 * atoms and routes all mutations through `useModelManagement()`.
 */
import { ConfirmModal } from "@/components/modals/ConfirmModal";
import { ReactModal } from "@/components/modals/ReactModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SearchBar } from "@/components/ui/SearchBar";
import { useApp } from "@/context";
import { logError } from "@/logger";
import type { ModelManagementApi } from "@/modelManagement/createModelManagement";
import { byokProvidersAtom, configuredModelsAtom } from "@/modelManagement/state/atoms";
import { BYOK_DEFAULT_AUTO_ENROLL } from "@/modelManagement/setup/ByokSetupApi";
import type { CatalogProvider, ModelInfo } from "@/modelManagement/types/catalog";
import type { Provider } from "@/modelManagement/types/persisted";
import type { VerificationResult } from "@/modelManagement/types/runtime";
import { ProviderCatalogList } from "@/modelManagement/ui/components/ProviderCatalogList";
import {
  ModelManagementProvider,
  useModelManagement,
} from "@/modelManagement/ui/ModelManagementContext";
import { settingsStore } from "@/settings/model";
import { useAtomValue } from "jotai";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { App, Notice } from "obsidian";
import React, { useMemo, useState } from "react";

/**
 * Default API endpoints for the SDK-native providers that models.dev omits an
 * `api` field for (so `CatalogProvider.defaultBaseUrl` is undefined). Used as
 * the Base URL placeholder and as the effective value when the field is left
 * blank, so adding these providers works without typing an endpoint. Keyed by
 * catalog provider id. The catalog's own `defaultBaseUrl` always takes
 * priority when present (e.g. DeepSeek and other openai-compatible providers).
 */
const KNOWN_DEFAULT_ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com",
};

export type ConfigureState =
  | { mode: "new"; catalog: CatalogProvider }
  | { mode: "edit"; providerId: string };

interface ConfigureProviderFormProps {
  state: ConfigureState;
  onClose: () => void;
}

/**
 * `ConfigureProviderForm` — pure body for the configure flow. The modal
 * shell owns open/close; this component owns the form state and mutations.
 */
export const ConfigureProviderForm: React.FC<ConfigureProviderFormProps> = ({ state, onClose }) => {
  const api = useModelManagement();
  const app = useApp();
  const byokProviders = useAtomValue(byokProvidersAtom, { store: settingsStore });
  const configuredModels = useAtomValue(configuredModelsAtom, { store: settingsStore });

  const provider = useMemo<Provider | undefined>(
    () =>
      state.mode === "edit"
        ? byokProviders.find((p) => p.providerId === state.providerId)
        : undefined,
    [state, byokProviders]
  );

  const existingModels = useMemo(
    () =>
      state.mode === "edit"
        ? configuredModels.filter((m) => m.providerId === state.providerId)
        : [],
    [state, configuredModels]
  );

  // The provider's dispatch type — drives credential verification.
  const providerType = state.mode === "new" ? state.catalog.providerType : provider?.providerType;

  // Catalog source for the model checklist. `new` uses the picked catalog
  // verbatim; `edit` looks the catalog up by the persisted origin id, and
  // falls back to a synthetic catalog built from the configured snapshots
  // when the live catalog can't resolve it (offline, or legacy row).
  const catalog = useMemo<CatalogProvider | undefined>(() => {
    if (state.mode === "new") return state.catalog;
    if (!provider) return undefined;
    const originId =
      provider.origin.kind === "byok" ? provider.origin.catalogProviderId : undefined;
    const live = originId ? api.catalogService.getProvider(originId) : undefined;
    if (live) return live;
    return {
      id: originId ?? provider.providerType,
      displayName: provider.displayName,
      providerType: provider.providerType,
      defaultBaseUrl: provider.baseUrl,
      models: Object.fromEntries(existingModels.map((m) => [m.info.id, m.info])),
    };
  }, [state, provider, existingModels, api]);

  const [displayName, setDisplayName] = useState(() =>
    state.mode === "new" ? state.catalog.displayName : (provider?.displayName ?? "")
  );
  const [apiKey, setApiKey] = useState("");
  // `new` mode leaves the field empty and shows the catalog URL as a
  // placeholder; an empty submit falls back to `template.defaultBaseUrl`.
  // `edit` mode keeps the saved override as the value.
  const [baseUrl, setBaseUrl] = useState(() =>
    state.mode === "new" ? "" : (provider?.baseUrl ?? "")
  );
  const [extras] = useState<Record<string, unknown>>(() =>
    state.mode === "new" ? {} : (provider?.extras ?? {})
  );
  const [selectedWireIds, setSelectedWireIds] = useState<Set<string>>(() =>
    state.mode === "new" ? new Set() : new Set(existingModels.map((m) => m.info.id))
  );
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelQuery, setModelQuery] = useState("");

  // Endpoint shown as the Base URL placeholder and used when the field is left
  // blank: the catalog's own URL wins, falling back to a known default for the
  // SDK-native providers models.dev omits one for.
  const defaultBaseUrl =
    catalog?.defaultBaseUrl ?? KNOWN_DEFAULT_ENDPOINTS[catalog?.id ?? ""] ?? "";
  const effectiveBaseUrl = baseUrl.trim() || defaultBaseUrl;

  const toggle = (wireId: string, next: boolean): void => {
    setSelectedWireIds((prev) => {
      const nextSet = new Set(prev);
      if (next) nextSet.add(wireId);
      else nextSet.delete(wireId);
      return nextSet;
    });
  };

  const handleTest = async (): Promise<void> => {
    if (!providerType) return;
    setTesting(true);
    try {
      if (state.mode === "new") {
        const synthetic: Provider = {
          providerId: "test",
          providerType,
          displayName,
          baseUrl: effectiveBaseUrl || undefined,
          extras,
          origin: { kind: "byok" },
          addedAt: Date.now(),
        };
        const result = await api.adapters.verifyCredentials(providerType, {
          provider: synthetic,
          apiKey: apiKey || null,
          extras: extras ?? {},
        });
        setVerification(result);
      } else if (provider) {
        // Edit mode: verify the freshly entered key, or fall back to the
        // saved one. Test must never persist the key — only "Save changes" does.
        // Verify against the edited form values (base URL especially), not the
        // stale persisted row, so the result reflects what Save will write.
        const key = apiKey || (await api.providerRegistry.getApiKey(state.providerId));
        const result = await api.adapters.verifyCredentials(providerType, {
          provider: { ...provider, displayName, baseUrl: effectiveBaseUrl || undefined, extras },
          apiKey: key || null,
          extras: extras ?? {},
        });
        setVerification(result);
      }
    } catch (err) {
      setVerification({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveNew = async (): Promise<void> => {
    if (state.mode !== "new") return;
    setSaving(true);
    try {
      await api.setup.byok.addCatalogProvider({
        template: state.catalog,
        displayName,
        baseUrl: effectiveBaseUrl || undefined,
        apiKey: apiKey || undefined,
        extras,
        selectedWireModelIds: [...selectedWireIds],
      });
      onClose();
    } catch (err) {
      logError("[ConfigureProviderDialog] addCatalogProvider failed", err);
      new Notice("Failed to save provider. See console for details.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (): Promise<void> => {
    if (state.mode !== "edit" || !provider) return;
    setSaving(true);
    try {
      const id = state.providerId;
      if (apiKey) await api.providerRegistry.setApiKey(id, apiKey);
      await api.providerRegistry.update(id, {
        displayName,
        baseUrl: effectiveBaseUrl || undefined,
        extras,
      });

      // Drop de-selected models from every backend picker before re-upserting.
      const deselectedIds = existingModels
        .filter((m) => !selectedWireIds.has(m.info.id))
        .map((m) => m.configuredModelId);
      if (deselectedIds.length > 0) {
        await api.backendConfigRegistry.removeRefs(deselectedIds);
      }

      const catalogModels = catalog?.models ?? {};
      const snapshotById = new Map(existingModels.map((m) => [m.info.id, m.info]));
      const prevWireIds = new Set(existingModels.map((m) => m.info.id));
      const entries = [...selectedWireIds]
        .map((wireId) => ({ wireId, info: catalogModels[wireId] ?? snapshotById.get(wireId) }))
        .filter((e): e is { wireId: string; info: ModelInfo } => e.info !== undefined);

      const ids = await api.configuredModelRegistry.bulkSet(
        id,
        entries.map((e) => e.info)
      );

      for (let i = 0; i < entries.length; i++) {
        if (prevWireIds.has(entries[i].wireId)) continue;
        // Embedding models aren't chat models — auto-enrolling them into
        // chat/agent backends would surface them in completion pickers where
        // they fail at inference. Mirrors ByokSetupApi.addCatalogProvider.
        if (entries[i].info.isEmbedding) continue;
        for (const backend of BYOK_DEFAULT_AUTO_ENROLL) {
          await api.backendConfigRegistry.enableModel(backend, ids[i]);
        }
      }
      onClose();
    } catch (err) {
      logError("[ConfigureProviderDialog] save changes failed", err);
      new Notice("Failed to save changes. See console for details.");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = (): void => {
    if (state.mode !== "edit" || !provider) return;
    const modal = new ConfirmModal(
      app,
      async () => {
        try {
          await api.coordinator.removeProvider(state.providerId);
          onClose();
        } catch (err) {
          logError("[ConfigureProviderDialog] removeProvider failed", err);
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

  const headerName =
    state.mode === "new" ? state.catalog.displayName : (provider?.displayName ?? displayName);
  const canSaveNew = verification?.ok === true && selectedWireIds.size > 0;
  const canSaveEdit = selectedWireIds.size > 0;

  const testFailed = verification?.ok === false;

  return (
    <div className="tw-flex tw-h-full tw-min-h-0 tw-flex-col tw-gap-4 tw-overflow-hidden">
      <div className="tw-flex tw-flex-col tw-gap-1 tw-border-b tw-border-border tw-px-2 tw-pb-3">
        <div className="tw-text-lg tw-font-semibold tw-leading-none tw-tracking-tight">
          Configure {headerName}
        </div>
        <div className="tw-text-sm tw-text-muted">
          Enter credentials and choose which models to enable.
        </div>
      </div>

      <div className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col tw-gap-4 tw-overflow-y-auto tw-px-2 tw-py-1">
        <FormField label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </FormField>

        <FormField
          label={
            <span className="tw-inline-flex tw-items-center tw-gap-2">
              API key
              {verification?.ok === true && (
                <Badge className="tw-gap-1 tw-bg-success tw-text-success">
                  <CheckCircle2 className="tw-size-3" />
                  Verified
                </Badge>
              )}
            </span>
          }
        >
          <div className="tw-flex tw-gap-2">
            <PasswordInput
              className="tw-flex-1"
              value={apiKey}
              onChange={(v) => {
                setApiKey(v);
                setVerification(null);
              }}
              autoDecrypt={false}
              placeholder={
                state.mode === "edit"
                  ? "Enter a new key to replace the saved one"
                  : "Paste your API key"
              }
            />
            <Button variant="secondary" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 className="tw-size-4 tw-animate-spin" /> : "Test"}
            </Button>
          </div>
          {testFailed && (
            <div className="tw-flex tw-items-center tw-gap-1.5 tw-text-xs tw-text-error">
              <XCircle className="tw-size-3.5 tw-shrink-0" />
              <span>{verification?.message || "Verification failed"}</span>
            </div>
          )}
        </FormField>

        <FormField label="Base URL">
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setVerification(null);
            }}
            placeholder={defaultBaseUrl}
          />
        </FormField>

        <div className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col tw-gap-2">
          <div className="tw-text-sm tw-font-medium tw-text-normal">Models</div>
          {catalog ? (
            <>
              <SearchBar
                value={modelQuery}
                onChange={setModelQuery}
                placeholder="Search models..."
              />
              <ProviderCatalogList
                catalog={catalog}
                selected={selectedWireIds}
                onToggle={toggle}
                query={modelQuery}
              />
            </>
          ) : (
            <div className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-p-4 tw-text-center tw-text-sm tw-text-muted">
              No models available.
            </div>
          )}
        </div>
      </div>

      {state.mode === "new" ? (
        <div className="tw-flex tw-flex-col-reverse tw-gap-2 tw-px-2 sm:tw-flex-row sm:tw-justify-end">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="default" onClick={handleSaveNew} disabled={!canSaveNew || saving}>
            {saving ? <Loader2 className="tw-size-4 tw-animate-spin" /> : "Verify & save"}
          </Button>
        </div>
      ) : (
        <div className="tw-flex tw-flex-col-reverse tw-gap-2 tw-px-2 sm:tw-flex-row sm:tw-justify-between">
          <Button variant="destructive" onClick={handleRemove} disabled={saving}>
            Remove provider
          </Button>
          <div className="tw-flex tw-gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="default" onClick={handleSaveEdit} disabled={!canSaveEdit || saving}>
              {saving ? <Loader2 className="tw-size-4 tw-animate-spin" /> : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

interface ConfigureProviderModalOptions {
  state: ConfigureState;
  api: ModelManagementApi;
}

/**
 * Native Obsidian modal hosting {@link ConfigureProviderForm}. Re-provides
 * the model-management api (a fresh React root doesn't inherit the settings
 * tree's context); jotai atoms read from the shared `settingsStore` and work
 * across roots.
 */
export class ConfigureProviderModal extends ReactModal {
  constructor(
    app: App,
    private readonly opts: ConfigureProviderModalOptions
  ) {
    super(app);
  }

  onOpen(): void {
    // Fixed, slightly-shorter-than-settings height so the form scrolls inside
    // the modal and the action footer stays pinned. The modal and its content
    // must be a bounded flex column for the inner `flex-1 + overflow-y-auto`
    // region to bound.
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
      <ModelManagementProvider api={this.opts.api}>
        <ConfigureProviderForm state={this.opts.state} onClose={close} />
      </ModelManagementProvider>
    );
  }
}
