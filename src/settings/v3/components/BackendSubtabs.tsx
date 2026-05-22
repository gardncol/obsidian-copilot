/**
 * BackendSubtabs — four-way sub-tab strip for the Agent panel.
 *
 * Order: OpenCode · Claude Code · Codex · Quick chat (Quick chat last).
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §5.4.
 */
import { cn } from "@/lib/utils";
import React from "react";

/**
 * Backend ids surfaced by the Agent panel. Order in this union is
 * intentional — Quick chat is last per spec §5.4.
 */
export type AgentBackendTabId = "opencode" | "claude" | "codex" | "quickChat";

export interface AgentBackendTabDescriptor {
  id: AgentBackendTabId;
  label: string;
}

/**
 * Canonical display order for the four Agent sub-tabs. Quick chat last.
 */
export const AGENT_BACKEND_TAB_ORDER: ReadonlyArray<AgentBackendTabDescriptor> = [
  { id: "opencode", label: "OpenCode" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "quickChat", label: "Quick chat" },
];

interface BackendSubtabsProps {
  /** Which sub-tab the user is currently looking at. */
  selectedTab: AgentBackendTabId;
  onSelectTab: (tab: AgentBackendTabId) => void;
}

/**
 * Render the four-way sub-tab strip.
 */
export const BackendSubtabs: React.FC<BackendSubtabsProps> = ({ selectedTab, onSelectTab }) => {
  return (
    <div
      role="tablist"
      aria-label="Agent backend"
      className="tw-flex tw-flex-wrap tw-gap-1 tw-border-b tw-border-solid tw-border-border"
      data-testid="backend-subtabs"
    >
      {AGENT_BACKEND_TAB_ORDER.map((tab) => {
        const isSelected = tab.id === selectedTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            data-testid={`backend-subtab-${tab.id}`}
            onClick={() => onSelectTab(tab.id)}
            className={cn(
              "tw-flex tw-items-center tw-gap-2 tw-rounded-t-md tw-border-x tw-border-t tw-border-solid tw-border-transparent tw-bg-transparent tw-px-3 tw-py-2 tw-text-ui-small tw-text-muted tw-transition-colors",
              "hover:tw-text-normal",
              isSelected &&
                "tw-border-border tw-bg-primary tw-text-normal tw-shadow-[0_1px_0_0_var(--background-primary)]"
            )}
          >
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
};
