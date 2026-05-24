import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

const mockEnsureLoaded = jest.fn().mockResolvedValue(undefined);
const mockGetAllProviders = jest.fn().mockReturnValue([]);
const mockOnChange = jest.fn().mockReturnValue(() => {});
const mockRemoveProvider = jest.fn().mockResolvedValue(undefined);
const mockAddProviderOpen = jest.fn();
const mockConfigureOpen = jest.fn();

jest.mock("@/modelManagement/ui/ModelManagementContext", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocks the real `useModelManagement` hook; the name must match the export
  useModelManagement: () => ({
    catalogService: {
      ensureLoaded: mockEnsureLoaded,
      getAllProviders: mockGetAllProviders,
      onChange: mockOnChange,
      refresh: jest.fn(),
    },
    coordinator: { removeProvider: mockRemoveProvider },
  }),
}));
// eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocks the real `useApp` hook; the name must match the export
jest.mock("@/context", () => ({ useApp: () => ({}) }));
jest.mock("@/modelManagement/state/atoms", () => {
  const jotai = jest.requireActual<typeof import("jotai")>("jotai");
  return {
    byokProvidersAtom: jotai.atom([
      {
        providerId: "p1",
        providerType: "anthropic",
        displayName: "Anthropic",
        origin: { kind: "byok", catalogProviderId: "anthropic" },
        addedAt: 0,
      },
    ]),
    configuredModelsAtom: jotai.atom([
      {
        configuredModelId: "m1",
        providerId: "p1",
        info: { id: "claude", displayName: "Claude Sonnet 4.5", limits: { context: 200000 } },
        configuredAt: 0,
      },
    ]),
  };
});
jest.mock("@/settings/model", () => {
  const jotai = jest.requireActual<typeof import("jotai")>("jotai");
  return { settingsStore: jotai.createStore() };
});
// Stub the modals — exercised by their own tests. Keeps this test focused
// on the panel's wiring and off the modals' heavy import chains.
jest.mock("@/modelManagement/ui/dialogs/ConfigureProviderDialog", () => ({
  ConfigureProviderModal: jest.fn().mockImplementation(() => ({ open: mockConfigureOpen })),
}));
jest.mock("@/modelManagement/ui/dialogs/AddProviderDialog", () => ({
  AddProviderModal: jest.fn().mockImplementation(() => ({ open: mockAddProviderOpen })),
}));

import { ByokPanel } from "./ByokPanel";

// Radix DropdownMenu portals resolve `activeDocument` at render time.
beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

describe("ByokPanel", () => {
  it("renders configured providers and their models after the catalog loads", async () => {
    render(<ByokPanel />);
    expect(await screen.findByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
  });

  it("opens the Add Provider modal from the add button", async () => {
    render(<ByokPanel />);
    await screen.findByText("Anthropic");
    fireEvent.click(screen.getByRole("button", { name: /Add a provider/i }));
    expect(mockAddProviderOpen).toHaveBeenCalled();
  });
});
