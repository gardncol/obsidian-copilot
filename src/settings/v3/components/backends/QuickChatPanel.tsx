/**
 * QuickChatPanel — UI skeleton for the Quick Chat agent backend's settings.
 *
 * Per spec §5.4.3, this is a SKELETON in M6:
 *   - Status card always says "Active — runs in the plugin" (no install).
 *   - BackendModelPicker sources chat-capable BYOK registry entries.
 *   - Persistence writes to `agentMode.backends.quickChat.modelEnabledOverrides`.
 *
 * No runtime routing wiring — clicking around saves settings but the chat
 * input still goes through the legacy ChatModelManager path. The follow-up
 * doc (`designdocs/QUICK_CHAT_AGENT_INTEGRATION.md`) will connect the wires.
 *
 * New session model + effort are inherited from the previous active session
 * via `AgentSessionManager.getLastSelection`, not from a persisted default.
 */
import { ModelRegistry, ProviderRegistry } from "@/modelManagement";
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
import { modelKey } from "@/settings/v3/components/backendPanelHelpers";
import React from "react";

interface QuickChatPanelProps {
  /** Callback to switch the settings shell to the BYOK tab. Optional. */
  onManageInByok?: () => void;
}

export const QuickChatPanel: React.FC<QuickChatPanelProps> = ({ onManageInByok }) => {
  // Subscribe so the toggle picker re-renders when settings mutate.
  useSettingsValue();

  const modelRegistry = ModelRegistry.getInstance();
  const providerRegistry = ProviderRegistry.getInstance();

  const overrides = readBackendOverrides("quickChat");
  const entries = modelRegistry.list();

  const rows: BackendModelPickerRow[] = entries.map((entry) => {
    const provider = providerRegistry.get(entry.providerId);
    const key = modelKey(entry.providerId, entry.modelId);
    return {
      key,
      name: entry.displayName,
      providerLabel: provider?.displayName ?? entry.providerId,
      enabled: isBackendModelEnabled(overrides, key),
    };
  });

  return (
    <div className="tw-space-y-4">
      <BackendModelPicker
        rows={rows}
        emptyPlaceholder="No chat-capable BYOK models yet. Add one in the BYOK tab to populate this list."
        onManageInByok={onManageInByok}
        onToggle={(key, enabled) => writeBackendOverride("quickChat", key, enabled)}
      />
    </div>
  );
};
