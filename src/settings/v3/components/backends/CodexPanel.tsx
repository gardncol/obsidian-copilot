/**
 * CodexPanel — Agent sub-panel for the Codex backend.
 *
 * Per §5.4.2:
 *   - Subscription card (OpenAI / Codex login).
 *   - Picker section sources from the backend's BUNDLED model list, read
 *     via `AgentSessionManager.getCachedBackendState("codex").model.availableModels`.
 *
 * Never reads global `app` — receives it via props.
 */
import { usePlugin } from "@/contexts/PluginContext";
import { useSettingsValue } from "@/settings/model";
import {
  BackendModelPicker,
  type BackendModelPickerRow,
} from "@/settings/v3/components/BackendModelPicker";
import {
  isBackendModelEnabled,
  readBackendOverrides,
  writeBackendOverride,
} from "@/settings/v3/components/backendOverrides";
import { findDescriptor } from "@/settings/v3/components/backendPanelHelpers";
import { logError } from "@/logger";
import type { App } from "obsidian";
import React from "react";

interface CodexPanelProps {
  app: App;
}

export const CodexPanel: React.FC<CodexPanelProps> = ({ app }) => {
  const settings = useSettingsValue();
  const plugin = usePlugin();
  const manager = plugin.agentSessionManager;

  const descriptor = findDescriptor("codex");

  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!manager) return;
    return manager.subscribeModelCache(forceUpdate);
  }, [manager]);

  const installState = descriptor?.getInstallState(settings) ?? { kind: "absent" as const };
  const overrides = readBackendOverrides("codex");
  const cachedState = manager?.getCachedBackendState("codex") ?? null;
  const availableModels = cachedState?.model?.availableModels ?? [];

  React.useEffect(() => {
    if (!manager) return;
    if (installState.kind !== "ready") return;
    if (cachedState) return;
    manager.preloadModels("codex").catch((e) => logError("[AgentMode] preload codex failed", e));
  }, [manager, installState.kind, cachedState]);

  const rows: BackendModelPickerRow[] = availableModels.map((entry) => ({
    key: entry.baseModelId,
    name: entry.name || entry.baseModelId,
    providerLabel: entry.provider ?? undefined,
    meta: entry.description,
    enabled: isBackendModelEnabled(overrides, entry.baseModelId),
  }));

  return (
    <div className="tw-space-y-4">
      <SubscriptionCard installKind={installState.kind} />

      {descriptor?.SettingsPanel && <descriptor.SettingsPanel plugin={plugin} app={app} />}

      <BackendModelPicker
        rows={rows}
        emptyPlaceholder="Bundled Codex models will appear here once the backend probes successfully."
        showManageInByokLink={false}
        onToggle={(key, enabled) => writeBackendOverride("codex", key, enabled)}
      />
    </div>
  );
};

const SubscriptionCard: React.FC<{ installKind: "ready" | "absent" | "error" }> = ({
  installKind,
}) => {
  if (installKind !== "ready") {
    return (
      <div
        className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-bg-primary-alt tw-p-3 tw-text-ui-small"
        data-testid="codex-subscription-card"
      >
        <div className="tw-text-warning">Not signed in</div>
        <div className="tw-mt-1 tw-text-ui-smaller tw-text-muted">
          Install <code>codex-acp</code> and sign in to enable Codex.
        </div>
      </div>
    );
  }
  return (
    <div
      className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-bg-primary-alt tw-p-3 tw-text-ui-small"
      data-testid="codex-subscription-card"
    >
      <div>Authenticated via the local Codex CLI.</div>
      <div className="tw-mt-1 tw-text-ui-smaller tw-text-muted">
        Re-authenticate by running <code>codex login</code> in your shell.
      </div>
    </div>
  );
};
