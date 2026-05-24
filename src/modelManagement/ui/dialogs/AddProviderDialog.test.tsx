import type { CatalogProvider } from "@/modelManagement/types/catalog";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { AddProviderContent } from "./AddProviderDialog";

// Radix Tooltip/Dialog portals resolve `activeDocument` at render time.
beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

function makeCatalog(id: string, displayName: string): CatalogProvider {
  return {
    id,
    displayName,
    providerType: id === "anthropic" ? "anthropic" : "openai-compatible",
    models: {},
  };
}

const catalog: CatalogProvider[] = [
  makeCatalog("anthropic", "Anthropic"),
  makeCatalog("openai", "OpenAI"),
  makeCatalog("google", "Google"),
  makeCatalog("groq", "Groq"),
];

function renderDialog(overrides: Partial<React.ComponentProps<typeof AddProviderContent>> = {}) {
  const props: React.ComponentProps<typeof AddProviderContent> = {
    catalogProviders: catalog,
    onPick: jest.fn(),
    ...overrides,
  };
  render(<AddProviderContent {...props} />);
  return props;
}

describe("AddProviderDialog", () => {
  it("splits providers into Recommended and More sections", () => {
    renderDialog();
    expect(screen.getByTestId("add-provider-recommended")).toBeTruthy();
    expect(screen.getByTestId("add-provider-card-anthropic")).toBeTruthy();
    expect(screen.getByTestId("add-provider-card-openai")).toBeTruthy();
    expect(screen.getByTestId("add-provider-card-google")).toBeTruthy();
    // Groq is not recommended → lands in "More providers".
    expect(screen.getByTestId("add-provider-more")).toBeTruthy();
    expect(screen.getByTestId("add-provider-card-groq")).toBeTruthy();
  });

  it("filters by search query", () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText("Search providers…"), {
      target: { value: "groq" },
    });
    expect(screen.queryByTestId("add-provider-card-anthropic")).toBeNull();
    expect(screen.getByTestId("add-provider-card-groq")).toBeTruthy();
  });

  it("calls onPick with the chosen provider", () => {
    const onPick = jest.fn();
    renderDialog({ onPick });
    fireEvent.click(screen.getByTestId("add-provider-card-anthropic"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "anthropic" }));
  });

  it("renders the custom-provider CTA disabled", () => {
    renderDialog();
    expect(screen.getByTestId("add-provider-custom-cta").hasAttribute("aria-disabled")).toBe(true);
  });
});
