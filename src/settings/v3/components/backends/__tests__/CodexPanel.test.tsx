/**
 * `CodexPanel` rendering tests.
 *
 * Scope (M6): mirror the ClaudeCodePanel structural checks. Codex shares the
 * same shape — the only difference is the descriptor + key prefix.
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

interface MockSettings {
  agentMode: {
    activeBackend: string;
    backends: Record<string, Record<string, never>>;
  };
}
let mockSettings: MockSettings = {
  agentMode: {
    activeBackend: "codex",
    backends: { codex: {} },
  },
};
jest.mock("@/settings/model", () => ({
  useSettingsValue: () => mockSettings,
  getSettings: () => mockSettings,
  setSettings: jest.fn(),
}));

const cachedBackendState = {
  model: {
    current: { baseModelId: "gpt-5.5", effort: null },
    availableModels: [
      {
        baseModelId: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        effortOptions: [],
      },
    ],
  },
  mode: null,
};

jest.mock("@/agentMode", () => ({
  listBackendDescriptors: () => [
    {
      id: "codex",
      displayName: "Codex",
      getInstallState: () => ({ kind: "ready", source: "managed" }),
      SettingsPanel: () => <div data-testid="codex-settings-panel" />,
    },
  ],
}));

jest.mock("@/contexts/PluginContext", () => ({
  usePlugin: () => ({
    app: {},
    agentSessionManager: {
      subscribeModelCache: () => () => {},
      getCachedBackendState: (id: string) => (id === "codex" ? cachedBackendState : null),
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

import { CodexPanel } from "@/settings/v3/components/backends/CodexPanel";

describe("CodexPanel", () => {
  it("renders the subscription card when the CLI is ready", () => {
    render(<CodexPanel app={{} as never} />);
    expect(screen.getByTestId("codex-subscription-card")).toBeTruthy();
  });

  it("renders bundled rows from the cached backend state (key = bare baseModelId)", () => {
    render(<CodexPanel app={{} as never} />);
    expect(screen.getByTestId("backend-model-row-gpt-5.5")).toBeTruthy();
  });
});
