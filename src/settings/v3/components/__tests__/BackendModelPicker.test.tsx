/**
 * `BackendModelPicker` rendering + interaction tests.
 *
 * Scope (M6):
 *  - Flat-mode renders one row per entry; empty placeholder when rows is empty.
 *  - Sectioned-mode renders section titles + nested rows; sections with no
 *    rows surface their `emptyPlaceholder` placeholder.
 *  - Checkbox toggles call `onToggle` with the row's key (which already
 *    uses the `<providerId>:<modelId>` format).
 *  - `Manage in BYOK →` link surfaces only when `onManageInByok` is set.
 */
import {
  BackendModelPicker,
  type BackendModelPickerRow,
} from "@/settings/v3/components/BackendModelPicker";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

function makeRow(overrides: Partial<BackendModelPickerRow> = {}): BackendModelPickerRow {
  return {
    key: "anthropic:claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    providerLabel: "Anthropic",
    meta: "200k ctx",
    enabled: true,
    ...overrides,
  };
}

describe("BackendModelPicker — flat", () => {
  it("renders one row per entry", () => {
    render(
      <BackendModelPicker
        rows={[
          makeRow({ key: "anthropic:claude-sonnet-4-5", name: "Claude Sonnet 4.5" }),
          makeRow({
            key: "openai:gpt-5",
            name: "GPT-5",
            providerLabel: "OpenAI",
            enabled: false,
          }),
        ]}
        onToggle={() => {}}
      />
    );
    expect(screen.getByTestId("backend-model-row-anthropic:claude-sonnet-4-5")).toBeTruthy();
    expect(screen.getByTestId("backend-model-row-openai:gpt-5")).toBeTruthy();
    expect(screen.queryByTestId("backend-model-picker-empty")).toBeNull();
  });

  it("renders the empty placeholder when rows is empty", () => {
    render(
      <BackendModelPicker
        rows={[]}
        emptyPlaceholder="No models registered yet."
        onToggle={() => {}}
      />
    );
    expect(screen.getByTestId("backend-model-picker-empty").textContent).toContain(
      "No models registered yet."
    );
  });

  it("fires onToggle with the row key and the new enabled value", () => {
    const onToggle = jest.fn();
    render(
      <BackendModelPicker
        rows={[makeRow({ key: "anthropic:claude-sonnet-4-5", enabled: false })]}
        onToggle={onToggle}
      />
    );
    const checkbox = screen.getByTestId("backend-model-checkbox-anthropic:claude-sonnet-4-5");
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith("anthropic:claude-sonnet-4-5", true);
  });

  it("renders the Manage in BYOK link only when onManageInByok is provided", () => {
    const onManage = jest.fn();
    const { rerender } = render(
      <BackendModelPicker rows={[]} onToggle={() => {}} onManageInByok={onManage} />
    );
    const link = screen.getByTestId("manage-in-byok");
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onManage).toHaveBeenCalledTimes(1);

    rerender(<BackendModelPicker rows={[]} onToggle={() => {}} />);
    expect(screen.queryByTestId("manage-in-byok")).toBeNull();
  });
});

describe("BackendModelPicker — sectioned", () => {
  it("renders section titles + rows", () => {
    render(
      <BackendModelPicker
        sections={[
          {
            title: "From BYOK",
            rows: [
              makeRow({
                key: "anthropic:claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
              }),
            ],
          },
          {
            title: "OpenCode-bundled",
            rows: [],
            emptyPlaceholder: "OpenCode-bundled models will appear here",
          },
        ]}
        onToggle={() => {}}
      />
    );
    expect(screen.getByTestId("backend-model-section-From BYOK")).toBeTruthy();
    expect(screen.getByTestId("backend-model-row-anthropic:claude-sonnet-4-5")).toBeTruthy();
    expect(
      screen.getByTestId("backend-model-section-empty-OpenCode-bundled").textContent
    ).toContain("OpenCode-bundled models will appear here");
  });

  it("toggles persist with the row's `<providerId>:<modelId>` key", () => {
    const onToggle = jest.fn();
    render(
      <BackendModelPicker
        sections={[
          {
            title: "From BYOK",
            rows: [makeRow({ key: "openai:gpt-5", enabled: true })],
          },
        ]}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByTestId("backend-model-checkbox-openai:gpt-5"));
    expect(onToggle).toHaveBeenCalledWith("openai:gpt-5", false);
  });

  it("hides a section entirely when rows is empty and no placeholder is set", () => {
    render(
      <BackendModelPicker
        sections={[
          { title: "From BYOK", rows: [makeRow({})] },
          { title: "Copilot Plus", rows: [] },
        ]}
        onToggle={() => {}}
      />
    );
    expect(screen.queryByTestId("backend-model-section-Copilot Plus")).toBeNull();
  });
});
