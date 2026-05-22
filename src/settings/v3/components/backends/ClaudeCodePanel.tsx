/**
 * ClaudeCodePanel — Agent sub-panel for the Claude Code backend.
 *
 * Per §5.4.2:
 *   - Subscription card with "Authenticated as <email>" + [Re-authenticate].
 *     The auth state is currently inferred from environment variables /
 *     resolver presence — we don't have an email source today, so the
 *     subscription line surfaces what we know (cli detected) with a
 *     placeholder for the real auth wiring.
 *   - Picker section sources from the backend's BUNDLED model list. The
 *     Claude SDK adapter populates this via `AgentSessionManager.preloadModels`,
 *     so we read from `getCachedBackendState("claude").model.availableModels`.
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

interface ClaudeCodePanelProps {
  app: App;
}

export const ClaudeCodePanel: React.FC<ClaudeCodePanelProps> = ({ app }) => {
  const settings = useSettingsValue();
  const plugin = usePlugin();
  const manager = plugin.agentSessionManager;

  const descriptor = findDescriptor("claude");

  // Subscribe to the preloader so newly-arrived agent-reported models
  // surface in both the picker and the dropdown.
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!manager) return;
    return manager.subscribeModelCache(forceUpdate);
  }, [manager]);

  const installState = descriptor?.getInstallState(settings) ?? { kind: "absent" as const };
  const overrides = readBackendOverrides("claude");
  const cachedState = manager?.getCachedBackendState("claude") ?? null;
  const availableModels = cachedState?.model?.availableModels ?? [];

  // Probe trigger — see OpencodePanel for the same pattern.
  React.useEffect(() => {
    if (!manager) return;
    if (installState.kind !== "ready") return;
    if (cachedState) return;
    manager.preloadModels("claude").catch((e) => logError("[AgentMode] preload claude failed", e));
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
        emptyPlaceholder="Bundled Claude Code models will appear here once the backend probes successfully."
        showManageInByokLink={false}
        onToggle={(key, enabled) => writeBackendOverride("claude", key, enabled)}
      />
    </div>
  );
};

/**
 * Subscription card placeholder. We don't yet have a structured signal for
 * the user's Anthropic login email — the Claude SDK inherits credentials
 * from the local CLI state. Surface what we know and leave a button for
 * re-authentication that opens the CLI install/setup helper.
 */
const SubscriptionCard: React.FC<{ installKind: "ready" | "absent" | "error" }> = ({
  installKind,
}) => {
  if (installKind !== "ready") {
    return (
      <div
        className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-bg-primary-alt tw-p-3 tw-text-ui-small"
        data-testid="claude-subscription-card"
      >
        <div className="tw-text-warning">Not signed in</div>
        <div className="tw-mt-1 tw-text-ui-smaller tw-text-muted">
          Install and sign in to the <code>claude</code> CLI to enable Claude Code.
        </div>
      </div>
    );
  }
  return (
    <div
      className="tw-rounded-md tw-border tw-border-solid tw-border-border tw-bg-primary-alt tw-p-3 tw-text-ui-small"
      data-testid="claude-subscription-card"
    >
      <div>
        Authenticated via the local <code>claude</code> CLI.
      </div>
      <div className="tw-mt-1 tw-text-ui-smaller tw-text-muted">
        Re-authenticate by running <code>claude /login</code> in your shell.
      </div>
    </div>
  );
};
