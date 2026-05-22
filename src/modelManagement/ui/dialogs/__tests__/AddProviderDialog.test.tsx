/**
 * `AddProviderDialog` tests — covers the picker layout and filtering rules.
 *
 * Scope (M5):
 *   - Renders Recommended + More providers sections.
 *   - Already-added providers are filtered out.
 *   - Picking a built-in card invokes `onPickBuiltin`.
 *   - Picking "Add a custom provider" invokes `onPickCustom`.
 */
import { AddProviderDialog } from "@/modelManagement/ui/dialogs/AddProviderDialog";
import type { ProviderConfig } from "@/modelManagement/types";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

// Radix portals reach for the codebase's shared `activeDocument`; jsdom
// doesn't define it. Alias to the test document.
beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

function makeProvider(id: string): ProviderConfig {
  return {
    id,
    kind: "builtin",
    displayName: id,
    type: "openai-compatible",
    addedAt: 1,
  };
}

describe("AddProviderDialog", () => {
  it("renders Recommended + More providers sections", () => {
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[]}
        onPickBuiltin={jest.fn()}
        onPickCustom={jest.fn()}
      />
    );

    expect(screen.getByTestId("add-provider-recommended")).toBeTruthy();
    expect(screen.getByTestId("add-provider-more")).toBeTruthy();
    // Three recommended providers visible.
    expect(screen.getByTestId("add-provider-card-anthropic")).toBeTruthy();
    expect(screen.getByTestId("add-provider-card-openai")).toBeTruthy();
    expect(screen.getByTestId("add-provider-card-google")).toBeTruthy();
  });

  it("filters out already-added providers", () => {
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[makeProvider("anthropic"), makeProvider("openai")]}
        onPickBuiltin={jest.fn()}
        onPickCustom={jest.fn()}
      />
    );

    expect(screen.queryByTestId("add-provider-card-anthropic")).toBeNull();
    expect(screen.queryByTestId("add-provider-card-openai")).toBeNull();
    // Google still visible.
    expect(screen.getByTestId("add-provider-card-google")).toBeTruthy();
  });

  it("excludes openai-compatible from the More providers picker", () => {
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[]}
        onPickBuiltin={jest.fn()}
        onPickCustom={jest.fn()}
      />
    );

    expect(screen.queryByTestId("add-provider-card-openai-compatible")).toBeNull();
  });

  it("invokes onPickBuiltin with the provider id when a card is clicked", () => {
    const onPickBuiltin = jest.fn();
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[]}
        onPickBuiltin={onPickBuiltin}
        onPickCustom={jest.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("add-provider-card-anthropic"));
    expect(onPickBuiltin).toHaveBeenCalledWith("anthropic");
  });

  it("invokes onPickCustom when the custom CTA card is clicked", () => {
    const onPickCustom = jest.fn();
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[]}
        onPickBuiltin={jest.fn()}
        onPickCustom={onPickCustom}
      />
    );

    fireEvent.click(screen.getByTestId("add-provider-custom-cta"));
    expect(onPickCustom).toHaveBeenCalledTimes(1);
  });

  it("filters provider lists as the user types in the search box", () => {
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[]}
        onPickBuiltin={jest.fn()}
        onPickCustom={jest.fn()}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search providers…");
    fireEvent.change(searchInput, { target: { value: "anth" } });

    expect(screen.getByTestId("add-provider-card-anthropic")).toBeTruthy();
    expect(screen.queryByTestId("add-provider-card-openai")).toBeNull();
    expect(screen.queryByTestId("add-provider-card-google")).toBeNull();
    expect(screen.queryByTestId("add-provider-card-cohere")).toBeNull();

    fireEvent.change(searchInput, { target: { value: "zzzz-no-match" } });
    expect(screen.queryByTestId("add-provider-card-anthropic")).toBeNull();
    expect(screen.getByText("No providers match your search.")).toBeTruthy();
  });

  it("renders no Recommended section when every recommended provider is already added", () => {
    render(
      <AddProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        existingProviders={[
          makeProvider("anthropic"),
          makeProvider("openai"),
          makeProvider("google"),
        ]}
        onPickBuiltin={jest.fn()}
        onPickCustom={jest.fn()}
      />
    );

    expect(screen.queryByTestId("add-provider-recommended")).toBeNull();
    // The More providers section still renders.
    expect(screen.getByTestId("add-provider-more")).toBeTruthy();
  });
});
