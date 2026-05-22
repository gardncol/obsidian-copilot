import { ResetSettingsConfirmModal } from "@/components/modals/ResetSettingsConfirmModal";
import { Button } from "@/components/ui/button";
import { TabContent, TabItem, type TabItem as TabItemType } from "@/components/ui/setting-tabs";
import { PluginProvider } from "@/contexts/PluginContext";
import { TabProvider, useTab } from "@/contexts/TabContext";
import { useLatestVersion } from "@/hooks/useLatestVersion";
import CopilotPlugin from "@/main";
import { ByokPanel } from "@/modelManagement";
import { resetSettings } from "@/settings/model";
import { AgentPanel } from "@/settings/v3/tabs/AgentPanel";
import { CommandSettings } from "@/settings/v2/components/CommandSettings";
import { SkillsSettings } from "@/agentMode";
import { Bot, Cog, Command, Database, KeyRound, Sparkle, Sparkles, Wrench } from "lucide-react";
import React from "react";
import { AdvancedSettings } from "./components/AdvancedSettings";
import { BasicSettings } from "./components/BasicSettings";
import { CopilotPlusSettings } from "./components/CopilotPlusSettings";
import { QASettings } from "./components/QASettings";

// M9: legacy "Models" tab removed; tab strip is now
// Chat (basic) · BYOK · Agent · Commands · Embedding · Skills · Plus · Advanced.
// Tab IDs are kept stable as route keys for backwards-compatible deep links.
const TAB_IDS = ["basic", "byok", "agent", "QA", "command", "skills", "plus", "advanced"] as const;
type TabId = (typeof TAB_IDS)[number];

// tab icons
const icons: Record<TabId, JSX.Element> = {
  basic: <Cog className="tw-size-5" />,
  byok: <KeyRound className="tw-size-5" />,
  agent: <Bot className="tw-size-5" />,
  QA: <Database className="tw-size-5" />,
  command: <Command className="tw-size-5" />,
  skills: <Sparkle className="tw-size-5" />,
  plus: <Sparkles className="tw-size-5" />,
  advanced: <Wrench className="tw-size-5" />,
};

interface SettingsTabComponentProps {
  plugin: CopilotPlugin;
  /** Switch the settings shell to a different tab. Wired by `SettingsContent`. */
  setSelectedTab: (id: TabId) => void;
}

// tab components
const components: Record<TabId, React.FC<SettingsTabComponentProps>> = {
  basic: () => <BasicSettings />,
  byok: ({ plugin }) => <ByokPanel app={plugin.app} />,
  agent: ({ plugin, setSelectedTab }) => (
    <AgentPanel app={plugin.app} onNavigateToByok={() => setSelectedTab("byok")} />
  ),
  QA: () => <QASettings />,
  command: () => <CommandSettings />,
  skills: () => <SkillsSettings />,
  plus: () => <CopilotPlusSettings />,
  advanced: () => <AdvancedSettings />,
};

// Tab labels — most tabs derive from the id, but "agent" capitalizes to a
// human-friendly label. The "QA" tab id is kept stable as a route key (so
// existing deep links keep working) while its label was renamed to
// "Embedding" in M3 of the Model Management redesign, reflecting that the
// tab now owns embedding-model management alongside indexing settings.
// M9: "Basic" → "Chat" and "Chat & Commands"/"Command" → "Commands" label
// renames per the Model Management redesign final tab strip.
const TAB_LABELS: Record<TabId, string> = {
  basic: "Chat",
  byok: "BYOK",
  agent: "Agents",
  QA: "Embedding",
  command: "Commands",
  skills: "Skills",
  plus: "Plus",
  advanced: "Advanced",
};

// tabs
const tabs: TabItemType[] = TAB_IDS.map((id) => ({
  id,
  icon: icons[id],
  label: TAB_LABELS[id],
}));

interface SettingsContentProps {
  plugin: CopilotPlugin;
}

const SettingsContent: React.FC<SettingsContentProps> = ({ plugin }) => {
  const { selectedTab, setSelectedTab } = useTab();

  return (
    <div className="tw-flex tw-flex-col">
      <div className="tw-flex tw-flex-wrap tw-rounded-lg">
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isSelected={selectedTab === tab.id}
            onClick={() => setSelectedTab(tab.id)}
            isFirst={index === 0}
            isLast={index === tabs.length - 1}
          />
        ))}
      </div>
      <div className="tw-w-full tw-border tw-border-solid" />

      <div>
        {TAB_IDS.map((id) => {
          const Component = components[id];
          return (
            <TabContent key={id} id={id} isSelected={selectedTab === id}>
              <Component plugin={plugin} setSelectedTab={setSelectedTab} />
            </TabContent>
          );
        })}
      </div>
    </div>
  );
};

interface SettingsMainV2Props {
  plugin: CopilotPlugin;
}

const SettingsMainV2: React.FC<SettingsMainV2Props> = ({ plugin }) => {
  // Add a key state that we'll change when resetting
  const [resetKey, setResetKey] = React.useState(0);
  const { latestVersion, hasUpdate } = useLatestVersion(plugin.manifest.version);

  const handleReset = () => {
    const modal = new ResetSettingsConfirmModal(plugin.app, () => {
      resetSettings();
      // Increment the key to force re-render of all components
      setResetKey((prev) => prev + 1);
    });
    modal.open();
  };

  return (
    <PluginProvider plugin={plugin}>
      <TabProvider>
        <div>
          <div className="tw-mb-4 tw-flex tw-flex-col tw-gap-2">
            {/* Reason: Obsidian's settings modal CSS hides plugin-rendered <h1>
                elements (display: none) because Obsidian reserves the top-level
                heading for itself. Use a div with heading-equivalent styling. */}
            <div
              role="heading"
              aria-level={1}
              className="tw-flex tw-flex-col tw-gap-2 tw-text-base tw-font-semibold sm:tw-flex-row sm:tw-items-center sm:tw-justify-between"
            >
              <div className="tw-flex tw-items-center tw-gap-2">
                <span>Copilot Settings</span>
                <div className="tw-flex tw-items-center tw-gap-1">
                  <span className="tw-text-xs tw-font-normal tw-text-muted">
                    v{plugin.manifest.version}
                  </span>
                  {latestVersion && (
                    <>
                      {hasUpdate ? (
                        <a
                          href="obsidian://show-plugin?id=copilot"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="tw-text-xs tw-font-normal tw-text-accent hover:tw-underline"
                        >
                          (Update to v{latestVersion})
                        </a>
                      ) : (
                        <span className="tw-text-xs tw-font-normal tw-text-normal">
                          {" "}
                          (up to date)
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="tw-self-end sm:tw-self-auto">
                <Button variant="secondary" size="sm" onClick={handleReset}>
                  Reset Settings
                </Button>
              </div>
            </div>
          </div>
          {/* Add the key prop to force re-render */}
          <SettingsContent key={resetKey} plugin={plugin} />
        </div>
      </TabProvider>
    </PluginProvider>
  );
};

export default SettingsMainV2;
