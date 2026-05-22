/**
 * Tests for the renamed "Embedding" tab (formerly "QA"). M3 of the Model
 * Management redesign added the embedding-models registry to the bottom
 * of this tab; these tests confirm the embedding section is mounted and
 * that the existing QA / indexing settings still render in place.
 *
 * Heavy dependencies (modals, the model add dialog, the embedding
 * manager) are stubbed so we can render synchronously and assert
 * structural facts without spinning up the full settings tree.
 */
import React from "react";
import { render } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/settings/model", () => ({
  updateSetting: jest.fn(),
  getModelKeyFromModel: (m: { name: string; provider: string }) => `${m.name}|${m.provider}`,
  useSettingsValue: jest.fn(() => ({
    enableMiyo: false,
    enableSemanticSearchV3: false,
    enableInlineCitations: false,
    embeddingModelKey: "text-embedding-3-small|openai",
    indexVaultToVectorStore: "ON MODE SWITCH",
    maxSourceChunks: 30,
    embeddingRequestsPerMin: 60,
    embeddingBatchSize: 16,
    numPartitions: 1,
    lexicalSearchRamLimit: 100,
    enableLexicalBoosts: true,
    qaExclusions: "",
    qaInclusions: "",
    enableIndexSync: false,
    disableIndexOnMobile: false,
    activeEmbeddingModels: [
      {
        name: "text-embedding-3-small",
        provider: "openai",
        enabled: true,
        isBuiltIn: true,
      },
    ],
  })),
}));

jest.mock("@/context", () => ({
  useApp: jest.fn(() => ({ vault: { configDir: ".test-config-dir" } })),
}));

jest.mock("@/components/modals/RebuildIndexConfirmModal", () => ({
  RebuildIndexConfirmModal: class {
    open() {}
  },
}));

jest.mock("@/components/modals/SemanticSearchToggleModal", () => ({
  SemanticSearchToggleModal: class {
    open() {}
  },
}));

jest.mock("@/components/ui/help-tooltip", () => ({
  HelpTooltip: () => <span data-testid="help-tooltip" />,
}));

jest.mock("@/components/ui/model-display", () => ({
  getModelDisplayWithIcons: (m: { name: string }) => m.name,
}));

jest.mock("@/components/ui/setting-item", () => ({
  SettingItem: (props: { title: string }) => (
    <div data-testid="setting-item" data-title={props.title} />
  ),
}));

jest.mock("@/settings/v2/components/PatternListEditor", () => ({
  PatternListEditor: () => <div data-testid="pattern-list-editor" />,
}));

// EmbeddingModelsSection itself is unit-tested separately. Stub here to a
// sentinel so we can confirm the QA tab mounts it.
jest.mock("@/settings/v2/components/EmbeddingModelsSection", () => ({
  EmbeddingModelsSection: () => <div data-testid="embedding-models-section" />,
}));

jest.mock("@/constants", () => ({
  VAULT_VECTOR_STORE_STRATEGIES: ["NEVER", "ON STARTUP", "ON MODE SWITCH"],
}));

jest.mock("obsidian", () => ({
  Notice: class {
    constructor(_: string) {}
  },
}));

// Reason: vectorStoreManager is dynamically imported only on toggle paths
// we don't exercise here; nothing further to mock.

// Import after mocks.
import { QASettings } from "@/settings/v2/components/QASettings";

describe("QASettings (Embedding tab)", () => {
  it("renders without throwing", () => {
    const view = render(<QASettings />);
    expect(view.container.querySelector("section")).not.toBeNull();
  });

  it("mounts the EmbeddingModelsSection at the bottom of the tab", () => {
    const view = render(<QASettings />);
    // Reason: M3 explicitly relocated the embedding-model registry to
    // this tab. If this assertion ever fails it means the section was
    // removed or moved elsewhere — both are regressions.
    expect(view.queryByTestId("embedding-models-section")).not.toBeNull();
  });

  it("still renders the existing QA / indexing settings (unchanged surface)", () => {
    const view = render(<QASettings />);
    const titles = Array.from(view.queryAllByTestId("setting-item")).map((el) =>
      el.getAttribute("data-title")
    );
    // Reason: smoke-check that the move-rename refactor didn't accidentally
    // drop any of the existing settings. We don't assert the full list to
    // keep this test resilient to copy edits.
    expect(titles).toContain("Enable Semantic Search");
    expect(titles).toContain("Embedding Model");
    expect(titles).toContain("Auto-Index Strategy");
    expect(titles).toContain("Max Sources");
  });
});
