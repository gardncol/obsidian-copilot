import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { ByokGlobalTable, type ByokTableGroup } from "./ByokGlobalTable";

// Radix DropdownMenu portals resolve `activeDocument` at render time.
beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

const group: ByokTableGroup = {
  provider: {
    providerId: "p1",
    providerType: "anthropic",
    displayName: "Anthropic",
    origin: { kind: "byok", catalogProviderId: "anthropic" },
    addedAt: 0,
  },
  models: [
    {
      configuredModelId: "m1",
      providerId: "p1",
      info: {
        id: "claude-sonnet",
        displayName: "Claude Sonnet 4.5",
        limits: { context: 200000 },
        releaseDate: "2025-09-01",
      },
      configuredAt: 0,
    },
    {
      configuredModelId: "m2",
      providerId: "p1",
      info: { id: "claude-opus", displayName: "Claude Opus 4.5" },
      configuredAt: 0,
    },
  ],
};

describe("ByokGlobalTable", () => {
  it("shows the empty state when there are no groups", () => {
    render(<ByokGlobalTable groups={[]} onConfigure={jest.fn()} onRemove={jest.fn()} />);
    expect(screen.getByTestId("byok-table-empty")).toBeTruthy();
  });

  it("renders the provider name, model count, and model rows", () => {
    render(<ByokGlobalTable groups={[group]} onConfigure={jest.fn()} onRemove={jest.fn()} />);
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText(/2 models/)).toBeTruthy();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("Claude Opus 4.5")).toBeTruthy();
    // Context window from the configured-model snapshot.
    expect(screen.getByText("200K")).toBeTruthy();
  });

  it("tags embedding models", () => {
    const withEmbedding: ByokTableGroup = {
      ...group,
      models: [
        {
          configuredModelId: "e1",
          providerId: "p1",
          info: {
            id: "text-embedding-3-small",
            displayName: "text-embedding-3-small",
            isEmbedding: true,
          },
          configuredAt: 0,
        },
      ],
    };
    render(
      <ByokGlobalTable groups={[withEmbedding]} onConfigure={jest.fn()} onRemove={jest.fn()} />
    );
    expect(screen.getByText("Embedding")).toBeTruthy();
  });

  it("collapses the model rows when the section header is clicked", () => {
    render(<ByokGlobalTable groups={[group]} onConfigure={jest.fn()} onRemove={jest.fn()} />);
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    fireEvent.click(screen.getByTestId("byok-section-p1"));
    expect(screen.queryByText("Claude Sonnet 4.5")).toBeNull();
  });
});
