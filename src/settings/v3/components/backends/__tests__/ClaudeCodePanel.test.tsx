/**
 * `ClaudeCodePanel` rendering tests.
 *
 * Scope:
 *  - Subscription card surfaces (re-)authenticated vs not-signed-in copy.
 *  - Bundled model picker sources from
 *    `AgentSessionManager.getCachedBackendState("claude").model.availableModels`.
 */
import { render, screen } from "@testing-library/react";
import React from "react";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

interface BackendSlice {
  modelEnabledOverrides?: Record<string, boolean>;
}
interface MockSettings {
  agentMode: {
    activeBackend: string;
    backends: Record<string, BackendSlice>;
  };
}
let mockSettings: MockSettings = {
  agentMode: {
    activeBackend: "claude",
    backends: { claude: {} },
  },
};
jest.mock("@/settings/model", () => ({
  useSettingsValue: () => mockSettings,
  getSettings: () => mockSettings,
  setSettings: jest.fn(),
}));

const cachedBackendState = {
  model: {
    current: { baseModelId: "claude-sonnet-4-5", effort: null },
    availableModels: [
      {
        baseModelId: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        effortOptions: [],
      },
    ],
  },
  mode: null,
};

jest.mock("@/agentMode", () => ({
  listBackendDescriptors: () => [
    {
      id: "claude",
      displayName: "Claude",
      getInstallState: () => ({ kind: "ready", source: "managed" }),
      SettingsPanel: () => <div data-testid="claude-settings-panel" />,
    },
  ],
}));

jest.mock("@/contexts/PluginContext", () => ({
  usePlugin: () => ({
    app: {},
    agentSessionManager: {
      subscribeModelCache: () => () => {},
      getCachedBackendState: (id: string) => (id === "claude" ? cachedBackendState : null),
      preloadModels: jest.fn().mockResolvedValue(undefined),
    },
  }),
}));

jest.mock("@/components/ui/setting-item", () => ({
  SettingItem: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <div data-testid={`setting-${title}`}>
      <span>{title}</span>
      {children}
    </div>
  ),
}));

import { ClaudeCodePanel } from "@/settings/v3/components/backends/ClaudeCodePanel";

describe("ClaudeCodePanel", () => {
  it("renders the subscription card when the CLI is ready", () => {
    mockSettings = {
      agentMode: {
        activeBackend: "claude",
        backends: { claude: {} },
      },
    };
    render(<ClaudeCodePanel app={{} as never} />);
    expect(screen.getByTestId("claude-subscription-card")).toBeTruthy();
  });

  it("renders bundled rows from the cached backend state (key = bare baseModelId)", () => {
    render(<ClaudeCodePanel app={{} as never} />);
    expect(screen.getByTestId("backend-model-row-claude-sonnet-4-5")).toBeTruthy();
  });
});
