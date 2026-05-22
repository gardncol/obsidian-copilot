/**
 * `ByokGlobalTable` rendering + interaction tests.
 *
 * Scope (M4):
 *  - Provider section rows + indented model rows render from props.
 *  - Chevron toggles fold/unfold and hides children when collapsed.
 *  - Section actions (Configure + Remove provider, both in the kebab) fire
 *    the right callbacks. The full filter-chip behavior is covered by the
 *    panel test; this file focuses on the inert rendering surface.
 */
import { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService";
import {
  ByokGlobalTable,
  type ByokTableProviderGroup,
} from "@/modelManagement/ui/components/ByokGlobalTable";
import type { ProviderConfig, RegistryEntry } from "@/modelManagement/types";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

// Catalog is the single source of truth for capabilities (context window,
// release date). Each test sets `getModel` to whatever it needs.
jest.mock("@/modelManagement/catalog/ModelCatalogService", () => ({
  ModelCatalogService: {
    getInstance: jest.fn(),
  },
}));
const mockGetInstance = ModelCatalogService.getInstance as jest.Mock;
const mockGetModel = jest.fn();
beforeEach(() => {
  mockGetModel.mockReset();
  mockGetInstance.mockReturnValue({ getModel: mockGetModel });
});

// Radix DropdownMenu uses pointer events + a portal that jsdom doesn't
// fully support. Replace it with a transparent wrapper so the menu items
// are always present in the rendered tree.
jest.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const item = ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <div role="menuitem" onClick={onClick}>
      {children}
    </div>
  );
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: item,
  };
});

// Radix DropdownMenu reaches for `activeDocument.body` via the codebase's
// shared portal helper. jsdom doesn't define `activeDocument` — polyfill
// it by aliasing to `window.document` (single-window environment).
beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

function makeProvider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "anthropic",
    kind: "builtin",
    displayName: "Anthropic",
    type: "anthropic",
    addedAt: 1,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RegistryEntry>): RegistryEntry {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    addedAt: 1,
    ...overrides,
  };
}

describe("ByokGlobalTable", () => {
  it("renders provider section rows + nested model rows", () => {
    const groups: ByokTableProviderGroup[] = [
      {
        provider: makeProvider({}),
        entries: [
          makeEntry({}),
          makeEntry({ modelId: "claude-opus-4-1", displayName: "Claude Opus 4.1" }),
        ],
      },
    ];

    render(
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={jest.fn()}
        onRemoveProvider={jest.fn()}
      />
    );

    // Section header content
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("2 models")).toBeTruthy();

    // Both model rows visible by default (sections are open by default).
    expect(screen.getByTestId("byok-model-anthropic-claude-sonnet-4-5")).toBeTruthy();
    expect(screen.getByTestId("byok-model-anthropic-claude-opus-4-1")).toBeTruthy();
  });

  it("collapses a section when the chevron is clicked and re-expands on click again", () => {
    const groups: ByokTableProviderGroup[] = [
      {
        provider: makeProvider({}),
        entries: [makeEntry({})],
      },
    ];

    render(
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={jest.fn()}
        onRemoveProvider={jest.fn()}
      />
    );

    const chevron = screen.getByLabelText("Collapse Anthropic");
    fireEvent.click(chevron);
    expect(screen.queryByTestId("byok-model-anthropic-claude-sonnet-4-5")).toBeNull();

    const reopen = screen.getByLabelText("Expand Anthropic");
    fireEvent.click(reopen);
    expect(screen.getByTestId("byok-model-anthropic-claude-sonnet-4-5")).toBeTruthy();
  });

  it("shows the custom-endpoint badge for kind:'custom' providers", () => {
    const groups: ByokTableProviderGroup[] = [
      {
        provider: makeProvider({
          id: "custom:abc",
          kind: "custom",
          displayName: "Local Ollama",
          type: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
        }),
        entries: [],
      },
    ];

    render(
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={jest.fn()}
        onRemoveProvider={jest.fn()}
      />
    );

    expect(screen.getByText("custom endpoint")).toBeTruthy();
  });

  it("fires onConfigureProvider when Configure is picked from the overflow menu", () => {
    const onConfigureProvider = jest.fn();
    const groups: ByokTableProviderGroup[] = [
      { provider: makeProvider({}), entries: [makeEntry({})] },
    ];

    render(
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={onConfigureProvider}
        onRemoveProvider={jest.fn()}
      />
    );

    const configureItem = screen.getByRole("menuitem", { name: /Configure/i });
    fireEvent.click(configureItem);
    expect(onConfigureProvider).toHaveBeenCalledWith("anthropic");
  });

  it("renders the empty-groups fallback message", () => {
    render(
      <ByokGlobalTable groups={[]} onConfigureProvider={jest.fn()} onRemoveProvider={jest.fn()} />
    );

    expect(screen.getByText(/No providers match the current filters\./i)).toBeTruthy();
  });

  it("renders context window + release date looked up from the catalog at render time", () => {
    mockGetModel.mockImplementation((providerId: string, modelId: string) => {
      if (providerId === "anthropic" && modelId === "claude-sonnet-4-5") {
        return { limit: { context: 200_000 }, release_date: "2025-09-29" };
      }
      return undefined;
    });
    const groups: ByokTableProviderGroup[] = [
      {
        provider: makeProvider({}),
        entries: [makeEntry({})],
      },
    ];

    render(
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={jest.fn()}
        onRemoveProvider={jest.fn()}
      />
    );

    expect(screen.getByTestId("byok-model-context-anthropic-claude-sonnet-4-5").textContent).toBe(
      "200k"
    );
    expect(screen.getByTestId("byok-model-release-anthropic-claude-sonnet-4-5").textContent).toBe(
      "Sep 2025"
    );
  });

  it("falls back to '—' when the catalog has no entry for the model (custom or pre-load)", () => {
    mockGetModel.mockReturnValue(undefined);
    const groups: ByokTableProviderGroup[] = [
      {
        provider: makeProvider({}),
        entries: [makeEntry({})],
      },
    ];

    render(
      <ByokGlobalTable
        groups={groups}
        onConfigureProvider={jest.fn()}
        onRemoveProvider={jest.fn()}
      />
    );

    expect(screen.getByTestId("byok-model-context-anthropic-claude-sonnet-4-5").textContent).toBe(
      "—"
    );
    expect(screen.getByTestId("byok-model-release-anthropic-claude-sonnet-4-5").textContent).toBe(
      "—"
    );
  });
});
