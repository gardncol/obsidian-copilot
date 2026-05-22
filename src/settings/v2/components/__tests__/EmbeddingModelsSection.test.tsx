/**
 * Tests for the EmbeddingModelsSection — the embedding-model registry
 * surface that moved from `ModelSettings.tsx` to the renamed "Embedding"
 * tab as part of M3 of the Model Management redesign.
 *
 * These tests don't mount the full ModelTable / ModelAddDialog trees (those
 * pull in dnd-kit, Radix portals, and the entire LangChain embedding
 * manager). Instead we stub them to forward props as `data-*` attributes
 * and assert that the props match the original ModelSettings behavior —
 * proving the refactor was a faithful move and not a rewrite.
 */
import React from "react";
import { render } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — keep the dep chain shallow so the component renders synchronously.
// ---------------------------------------------------------------------------

const updateSettingMock = jest.fn();

jest.mock("@/settings/model", () => ({
  updateSetting: (...args: unknown[]) => {
    updateSettingMock(...args);
  },
  useSettingsValue: jest.fn(() => ({
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
  useApp: jest.fn(() => ({})),
}));

jest.mock("@/LLMProviders/embeddingManager", () => ({
  __esModule: true,
  default: { getInstance: () => ({ ping: jest.fn() }) },
}));

jest.mock("@/constants", () => ({
  BUILTIN_EMBEDDING_MODELS: [],
}));

jest.mock("@/utils", () => ({
  omit: (obj: Record<string, unknown>, keys: string[]) => {
    const out = { ...obj };
    for (const k of keys) delete out[k];
    return out;
  },
}));

// Reason: ModelTable pulls dnd-kit and Radix. Stub it to a leaf that
// surfaces the props we care about so we can verify them in assertions.
jest.mock("@/settings/v2/components/ModelTable", () => ({
  ModelTable: (props: { title: string; models: unknown[] }) => (
    <div data-testid="model-table" data-title={props.title} data-count={props.models.length} />
  ),
}));

jest.mock("@/settings/v2/components/ModelAddDialog", () => ({
  ModelAddDialog: (props: { isEmbeddingModel?: boolean; open: boolean }) => (
    <div
      data-testid="model-add-dialog"
      data-is-embedding={String(Boolean(props.isEmbeddingModel))}
      data-open={String(props.open)}
    />
  ),
}));

jest.mock("@/settings/v2/components/ModelEditDialog", () => ({
  ModelEditModal: class {
    open() {}
  },
}));

jest.mock("obsidian", () => ({
  Notice: class {
    constructor(_: string) {}
  },
}));

// Import after mocks so the module sees them.
import { EmbeddingModelsSection } from "@/settings/v2/components/EmbeddingModelsSection";

describe("EmbeddingModelsSection", () => {
  beforeEach(() => {
    updateSettingMock.mockClear();
  });

  it("renders the embedding-models ModelTable wired to activeEmbeddingModels", () => {
    const view = render(<EmbeddingModelsSection />);

    const table = view.getByTestId("model-table");
    expect(table.getAttribute("data-title")).toBe("Embedding Models");
    // Reason: confirms we passed `activeEmbeddingModels` (1 entry in our
    // mocked settings) and NOT `activeModels`.
    expect(table.getAttribute("data-count")).toBe("1");
  });

  it("renders the add-dialog in embedding mode (closed by default)", () => {
    const view = render(<EmbeddingModelsSection />);

    const dialog = view.getByTestId("model-add-dialog");
    // Reason: pinning isEmbeddingModel = true is what differentiates this
    // section from the chat-model add dialog in ModelSettings.tsx.
    expect(dialog.getAttribute("data-is-embedding")).toBe("true");
    expect(dialog.getAttribute("data-open")).toBe("false");
  });
});
