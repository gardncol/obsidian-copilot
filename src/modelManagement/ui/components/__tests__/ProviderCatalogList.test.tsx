/**
 * `ProviderCatalogList` tests — confirms the rendering contract used by the
 * Configure Provider dialog.
 *
 * Scope (M5):
 *   - Ungrouped rendering for regular providers.
 *   - Sticky upstream-provider headers for OpenRouter (id includes `/`).
 *   - Checkbox toggles fire `onToggle` with the model id (not the key).
 *   - Empty state renders when no models are supplied.
 */
import {
  ProviderCatalogList,
  type ProviderCatalogListProps,
} from "@/modelManagement/ui/components/ProviderCatalogList";
import type { CatalogModel } from "@/modelManagement/catalog/modelsCatalog.types";
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

function makeModel(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
  const { id, name, limit, ...rest } = overrides;
  return {
    id,
    name: name ?? id,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: limit?.context ?? 200_000, output: limit?.output ?? 8_000 },
    ...rest,
  };
}

function renderList(props: Partial<ProviderCatalogListProps>): void {
  render(
    <ProviderCatalogList
      providerId={props.providerId ?? "anthropic"}
      models={props.models ?? []}
      selectedModelIds={props.selectedModelIds ?? new Set<string>()}
      onToggle={props.onToggle ?? jest.fn()}
      showKebab={props.showKebab}
      registeredModelIds={props.registeredModelIds}
      onViewDocs={props.onViewDocs}
      onRemoveFromRegistry={props.onRemoveFromRegistry}
      emptyMessage={props.emptyMessage}
    />
  );
}

describe("ProviderCatalogList", () => {
  it("renders an empty-state message when no models match", () => {
    renderList({ models: [] });
    expect(screen.getByTestId("catalog-list-empty")).toBeTruthy();
  });

  it("renders rows ungrouped for a non-OpenRouter provider", () => {
    renderList({
      providerId: "anthropic",
      models: [
        makeModel({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }),
        makeModel({ id: "claude-opus-4-1", name: "Claude Opus 4.1" }),
      ],
    });
    expect(screen.getByTestId("catalog-row-anthropic-claude-sonnet-4-5")).toBeTruthy();
    expect(screen.getByTestId("catalog-row-anthropic-claude-opus-4-1")).toBeTruthy();
    // No upstream-provider header for non-OpenRouter providers.
    expect(screen.queryByTestId(/^catalog-upstream-/)).toBeNull();
  });

  it("renders sticky upstream-provider headers for OpenRouter", () => {
    renderList({
      providerId: "openrouter",
      models: [
        makeModel({ id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" }),
        makeModel({ id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1" }),
        makeModel({ id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" }),
      ],
    });
    expect(screen.getByTestId("catalog-upstream-anthropic")).toBeTruthy();
    expect(screen.getByTestId("catalog-upstream-google")).toBeTruthy();
  });

  it("fires onToggle with the model id when a checkbox is clicked", () => {
    const onToggle = jest.fn();
    renderList({
      providerId: "anthropic",
      models: [makeModel({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" })],
      onToggle,
    });

    // Click the row's label — Radix Checkbox proxies the click through.
    const row = screen.getByTestId("catalog-row-anthropic-claude-sonnet-4-5");
    const checkbox = row.querySelector("button[role='checkbox']") as HTMLElement;
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith("claude-sonnet-4-5");
  });

  it("only shows the kebab on registered rows when showKebab is true", () => {
    renderList({
      providerId: "anthropic",
      models: [
        makeModel({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }),
        makeModel({ id: "claude-opus-4-1", name: "Claude Opus 4.1" }),
      ],
      showKebab: true,
      registeredModelIds: new Set(["anthropic:claude-sonnet-4-5"]),
    });
    // Kebab present on the registered row only.
    expect(screen.getByLabelText("More actions for Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.queryByLabelText("More actions for Claude Opus 4.1")).toBeNull();
  });

  it("formats release_date into a human-readable column", () => {
    renderList({
      providerId: "anthropic",
      models: [
        makeModel({
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          release_date: "2025-09-15",
        }),
      ],
    });
    const cell = screen.getByTestId("catalog-release-anthropic-claude-sonnet-4-5");
    expect(cell.textContent).toMatch(/Sep 2025/);
  });
});
