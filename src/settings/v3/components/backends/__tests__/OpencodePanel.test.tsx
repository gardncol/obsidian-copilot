/**
 * `OpencodePanel` rendering tests.
 *
 * Scope:
 *   - All three sections (Bundled / Plus / BYOK) source from
 *     `listOpencodeBuckets`, which classifies the OpenCode probe-cache
 *     `availableModels` list by leading wire-form segment.
 *   - Override-key shape is the bare wire-form `baseModelId` for every
 *     row — no per-section prefix.
 *   - When the probe cache is empty / null, the Bundled section shows the
 *     "OpenCode not installed" empty-state and the BYOK section shows the
 *     "Install OpenCode to preview" copy.
 *   - The Plus section is suppressed when `isPlusUser === false`.
 *   - Toggles in each section write `entry.baseModelId` keys via
 *     `writeBackendOverride("opencode", …)`.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
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
    activeBackend: "opencode",
    backends: {
      opencode: {},
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

// Memoized singletons — `ProviderRegistry.getInstance()` must return the
// SAME object across renders, otherwise the panel's `[providerRegistry]`
// effect dep changes every render and the test's microtask flush races
// with the re-spawned fetches.
jest.mock("@/modelManagement", () => {
  const providerRegistry = {
    get: (id: string) => (id === "openai" ? { id, displayName: "OpenAI" } : undefined),
    list: () => [] as never[],
  };
  const modelRegistry = { list: () => [] as never[] };
  return {
    ModelRegistry: { getInstance: () => modelRegistry },
    ProviderRegistry: { getInstance: () => providerRegistry },
  };
});

interface BucketsValue {
  bundled: Array<{ baseModelId: string; name: string }>;
  byok: Array<{ baseModelId: string; name: string }>;
  plus: Array<{ baseModelId: string; name: string }>;
}
let bucketsResult: BucketsValue | null = {
  bundled: [{ baseModelId: "bigpickle/big-pickle", name: "Big Pickle" }],
  byok: [{ baseModelId: "openai/gpt-5", name: "GPT-5" }],
  plus: [{ baseModelId: "copilot-plus/copilot-plus-flash", name: "Copilot Plus Flash" }],
};
const listBucketsMock = jest.fn(async () => bucketsResult);
let plusFallback: Array<{ id: string; displayName: string }> = [];
const listPlusMock = jest.fn(async () => plusFallback);

let isPlusUserMock = true;
jest.mock("@/plusUtils", () => ({
  useIsPlusUser: () => isPlusUserMock,
}));

jest.mock("@/agentMode", () => ({
  listBackendDescriptors: () => [
    {
      id: "opencode",
      displayName: "OpenCode",
      getInstallState: () => ({ kind: "ready", source: "managed" }),
      SettingsPanel: () => <div data-testid="opencode-settings-panel" />,
    },
  ],
  listOpencodeBuckets: () => listBucketsMock(),
  listOpencodePlusModels: () => listPlusMock(),
}));

// Stable plugin handle — recreating on every render would invalidate the
// `[manager]` dep of the panel's bucket-fetch effect and cause an infinite
// re-render loop in tests.
const mockPlugin = {
  app: {},
  agentSessionManager: {
    subscribeModelCache: () => () => {},
    getCachedBackendState: () => null,
    preloadModels: jest.fn().mockResolvedValue(undefined),
  },
};
jest.mock("@/contexts/PluginContext", () => ({
  usePlugin: () => mockPlugin,
}));

jest.mock("@/components/ui/setting-item", () => ({
  SettingItem: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <div data-testid={`setting-${title}`}>
      <span>{title}</span>
      {children}
    </div>
  ),
}));

import { OpencodePanel } from "@/settings/v3/components/backends/OpencodePanel";

/**
 * Render the panel and let the async bucket / plus-fallback fetches resolve.
 */
async function renderPanel(): Promise<void> {
  render(<OpencodePanel app={{} as never} />);
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OpencodePanel", () => {
  beforeEach(() => {
    mockSettings = {
      agentMode: {
        activeBackend: "opencode",
        backends: {
          opencode: {},
        },
      },
    };
    setSettingsMock.mockClear();
    bucketsResult = {
      bundled: [{ baseModelId: "bigpickle/big-pickle", name: "Big Pickle" }],
      byok: [{ baseModelId: "openai/gpt-5", name: "GPT-5" }],
      plus: [{ baseModelId: "copilot-plus/copilot-plus-flash", name: "Copilot Plus Flash" }],
    };
    plusFallback = [];
    isPlusUserMock = true;
    listBucketsMock.mockClear();
    listPlusMock.mockClear();
  });

  it("renders all three sections with bare baseModelId keys", async () => {
    await renderPanel();
    expect(screen.getByTestId("backend-model-section-OpenCode-bundled")).toBeTruthy();
    expect(screen.getByTestId("backend-model-row-bigpickle/big-pickle")).toBeTruthy();
    expect(screen.getByTestId("backend-model-section-Copilot Plus")).toBeTruthy();
    expect(screen.getByTestId("backend-model-row-copilot-plus/copilot-plus-flash")).toBeTruthy();
    expect(screen.getByTestId("backend-model-section-From BYOK")).toBeTruthy();
    expect(screen.getByTestId("backend-model-row-openai/gpt-5")).toBeTruthy();
  });

  it("renders the OpenCode-not-installed empty-state when listOpencodeBuckets returns null", async () => {
    bucketsResult = null;
    await renderPanel();
    expect(screen.getByTestId("backend-model-section-empty-OpenCode-bundled")).toBeTruthy();
    expect(screen.getByTestId("backend-model-section-empty-OpenCode-bundled").textContent).toMatch(
      /not installed/i
    );
    // BYOK section also shows its install-OpenCode placeholder.
    expect(screen.getByTestId("backend-model-section-empty-From BYOK")).toBeTruthy();
  });

  it("renders the OpenCode-not-installed empty-state when listOpencodeBuckets throws", async () => {
    listBucketsMock.mockRejectedValueOnce(new Error("probe failed"));
    await renderPanel();
    expect(screen.getByTestId("backend-model-section-empty-OpenCode-bundled")).toBeTruthy();
    expect(screen.getByTestId("backend-model-section-empty-From BYOK")).toBeTruthy();
  });

  it("hides the Copilot Plus section when isPlusUser is false", async () => {
    isPlusUserMock = false;
    await renderPanel();
    expect(screen.queryByTestId("backend-model-section-Copilot Plus")).toBeNull();
    expect(screen.getByTestId("backend-model-section-OpenCode-bundled")).toBeTruthy();
    expect(screen.getByTestId("backend-model-section-From BYOK")).toBeTruthy();
  });

  it("toggles a bundled row using the bare baseModelId as the override key", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId("backend-model-checkbox-bigpickle/big-pickle"));
    const updater = setSettingsMock.mock.calls.at(-1)?.[0] as (
      cur: MockSettings
    ) => Partial<MockSettings>;
    const patch = updater(mockSettings);
    expect(
      patch.agentMode?.backends?.opencode?.modelEnabledOverrides?.["bigpickle/big-pickle"]
    ).toBe(false);
  });

  it("toggles a plus row using the bare baseModelId as the override key", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId("backend-model-checkbox-copilot-plus/copilot-plus-flash"));
    const updater = setSettingsMock.mock.calls.at(-1)?.[0] as (
      cur: MockSettings
    ) => Partial<MockSettings>;
    const patch = updater(mockSettings);
    expect(
      patch.agentMode?.backends?.opencode?.modelEnabledOverrides?.[
        "copilot-plus/copilot-plus-flash"
      ]
    ).toBe(false);
  });

  it("toggles a BYOK row using the bare baseModelId as the override key", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId("backend-model-checkbox-openai/gpt-5"));
    const updater = setSettingsMock.mock.calls.at(-1)?.[0] as (
      cur: MockSettings
    ) => Partial<MockSettings>;
    const patch = updater(mockSettings);
    expect(patch.agentMode?.backends?.opencode?.modelEnabledOverrides?.["openai/gpt-5"]).toBe(
      false
    );
  });
});
