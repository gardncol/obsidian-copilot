/**
 * AgentPanel — top-level Agent tab (replaces the legacy AgentSettings).
 *
 * Lays out a four-way sub-tab strip (OpenCode · Claude Code · Codex ·
 * Quick chat — Quick chat LAST) and renders the matching sub-panel.
 *
 * Cross-tab navigation to the BYOK tab is exposed via the `onNavigateToByok`
 * prop. When omitted, panels suppress the `Manage in BYOK →` link.
 *
 * Never reads global `app` — threaded via props (popout safety).
 */
import { McpServersPanel } from "@/agentMode";
import { useSettingsValue } from "@/settings/model";
import {
  AGENT_BACKEND_TAB_ORDER,
  BackendSubtabs,
  type AgentBackendTabId,
} from "@/settings/v3/components/BackendSubtabs";
import { ClaudeCodePanel } from "@/settings/v3/components/backends/ClaudeCodePanel";
import { CodexPanel } from "@/settings/v3/components/backends/CodexPanel";
import { OpencodePanel } from "@/settings/v3/components/backends/OpencodePanel";
import { QuickChatPanel } from "@/settings/v3/components/backends/QuickChatPanel";
import { App, Platform } from "obsidian";
import React from "react";

interface AgentPanelProps {
  app: App;
  /**
   * Switch the settings shell to the BYOK tab. Wired by `SettingsMainV2`
   * via the TabContext. Optional — when missing, the per-backend panels
   * hide the `Manage in BYOK →` link.
   */
  onNavigateToByok?: () => void;
}

/** Coerce an arbitrary `agentMode.activeBackend` string into a known sub-tab id. */
function asAgentBackendTab(id: string | undefined): AgentBackendTabId | null {
  if (id === "opencode" || id === "claude" || id === "codex" || id === "quickChat") {
    return id;
  }
  return null;
}

export const AgentPanel: React.FC<AgentPanelProps> = ({ app, onNavigateToByok }) => {
  const settings = useSettingsValue();

  // Default the selected sub-tab to whichever backend is active (when it
  // maps to one of the four sub-tabs); otherwise the spec order kicks in
  // and we land on OpenCode.
  const initialTab =
    asAgentBackendTab(settings.agentMode?.activeBackend) ?? AGENT_BACKEND_TAB_ORDER[0].id;
  const [selectedTab, setSelectedTab] = React.useState<AgentBackendTabId>(initialTab);

  if (Platform.isMobile) {
    return (
      <section>
        <div className="tw-mb-3 tw-text-xl tw-font-bold">Agents</div>
        <div className="tw-text-muted">
          Agent Mode is desktop only. Open the desktop app to configure agents.
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="tw-mb-3 tw-text-xl tw-font-bold">Agents</div>

      <BackendSubtabs selectedTab={selectedTab} onSelectTab={setSelectedTab} />

      <div className="tw-mt-4">
        {selectedTab === "opencode" && (
          <OpencodePanel app={app} onManageInByok={onNavigateToByok} />
        )}
        {selectedTab === "claude" && <ClaudeCodePanel app={app} />}
        {selectedTab === "codex" && <CodexPanel app={app} />}
        {selectedTab === "quickChat" && <QuickChatPanel onManageInByok={onNavigateToByok} />}
      </div>

      <div className="tw-mt-6">
        <McpServersPanel />
      </div>
    </section>
  );
};
