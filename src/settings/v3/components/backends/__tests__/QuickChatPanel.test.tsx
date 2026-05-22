/**
 * `QuickChatPanel` rendering tests.
 *
 * Scope:
 *  - Status card always shows the "Active" state (Quick Chat needs no install).
 *  - Picker rows persist via `writeBackendOverride("quickChat", …)`.
 *
 * The panel no longer surfaces a Default model dropdown — new sessions
 * inherit (model, effort) from the previous active session via
 * `AgentSessionManager.getLastSelection`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
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
  agentMode: { backends: Record<string, BackendSlice> };
}
let mockSettings: MockSettings = {
  agentMode: {
    backends: {
      quickChat: {},
    },
  },
};
const setSettingsMock = jest.fn(
  (updater: ((cur: MockSettings) => Partial<MockSettings>) | Partial<MockSettings>) => {
    const patch = typeof updater === "function" ? updater(mockSettings) : updater;
    mockSettings = { ...mockSettings, ...patch };
  }
);
jest.mock("@/settings/model", () => ({
  useSettingsValue: () => mockSettings,
  getSettings: () => mockSettings,
  setSettings: (u: unknown) => setSettingsMock(u as never),
}));

const chatModels = [
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    addedAt: 1,
  },
];
jest.mock("@/modelManagement", () => ({
  ModelRegistry: {
    getInstance: () => ({
      list: () => chatModels,
    }),
  },
  ProviderRegistry: {
    getInstance: () => ({
      get: (id: string) => (id === "anthropic" ? { displayName: "Anthropic" } : undefined),
      list: () => [],
    }),
  },
}));

import { QuickChatPanel } from "@/settings/v3/components/backends/QuickChatPanel";

describe("QuickChatPanel", () => {
  beforeEach(() => {
    mockSettings = {
      agentMode: {
        backends: {
          quickChat: {},
        },
      },
    };
    setSettingsMock.mockClear();
  });

  it("lists chat-capable registry entries in the picker", () => {
    render(<QuickChatPanel />);
    expect(screen.getByTestId("backend-model-row-anthropic:claude-sonnet-4-5")).toBeTruthy();
  });

  it("toggles overrides via writeBackendOverride", () => {
    render(<QuickChatPanel />);
    fireEvent.click(screen.getByTestId("backend-model-checkbox-anthropic:claude-sonnet-4-5"));
    expect(setSettingsMock).toHaveBeenCalled();
    // Walk the latest set call's patch through to see the persisted override.
    const updater = setSettingsMock.mock.calls.at(-1)?.[0] as (
      cur: MockSettings
    ) => Partial<MockSettings>;
    const patch = updater(mockSettings);
    const quickChat = patch.agentMode?.backends?.quickChat;
    expect(quickChat?.modelEnabledOverrides?.["anthropic:claude-sonnet-4-5"]).toBe(false);
  });

  it("does not render a Default model or Default reasoning effort row", () => {
    render(<QuickChatPanel />);
    expect(screen.queryByTestId("setting-Default model")).toBeNull();
    expect(screen.queryByTestId("setting-Default reasoning effort")).toBeNull();
  });
});
