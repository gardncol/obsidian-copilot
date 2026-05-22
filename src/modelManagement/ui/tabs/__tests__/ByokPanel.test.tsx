/**
 * `ByokPanel` rendering tests.
 *
 * Scope:
 *  - Mounts a skeleton during ensureLoaded() and swaps to the populated /
 *    empty state once it resolves.
 *  - Empty state shows when no providers are configured.
 *  - Populated state renders provider sections.
 *  - Search input filters model rows by name.
 *
 * The catalog + registry singletons are mocked at the module level so we
 * don't drag in the settings store, the migration system, or Obsidian
 * APIs we don't care about for this view.
 */
import type { CatalogMeta } from "@/modelManagement/catalog/modelsCatalog.types";
import type { ProviderConfig, RegistryEntry } from "@/modelManagement/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

// Radix DropdownMenu portal helper uses the codebase's shared
// `activeDocument` global. jsdom doesn't define it — alias to
// `window.document` (single-window environment).
beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

const ensureLoadedMock = jest.fn().mockResolvedValue(undefined);
const refreshMock = jest.fn().mockResolvedValue({ ok: true, source: "live" });
const getMetaMock = jest.fn<CatalogMeta, []>().mockReturnValue({
  fetchedAt: Date.now(),
  source: "disk",
});
const getAllProvidersMock = jest.fn().mockReturnValue([
  { id: "anthropic", models: { a: {}, b: {} } },
  { id: "openai", models: { c: {} } },
]);
const catalogOnChange = jest.fn(() => () => {});

jest.mock("@/modelManagement/catalog/ModelCatalogService", () => ({
  ModelCatalogService: {
    getInstance: () => ({
      ensureLoaded: ensureLoadedMock,
      refresh: refreshMock,
      getMeta: getMetaMock,
      getAllProviders: getAllProvidersMock,
      // ByokGlobalTable looks up capabilities (context, release date) at
      // render time. These tests don't care about either column, so we just
      // return undefined and let the UI render the "—" fallback.
      getModel: () => undefined,
      onChange: catalogOnChange,
    }),
  },
}));

let providers: ProviderConfig[] = [];
let registry: RegistryEntry[] = [];
const providerListeners = new Set<() => void>();
const registryListeners = new Set<() => void>();

const providerRemoveMock = jest.fn(async (id: string) => {
  providers = providers.filter((p) => p.id !== id);
  registry = registry.filter((e) => e.providerId !== id);
  providerListeners.forEach((fn) => fn());
  registryListeners.forEach((fn) => fn());
});

jest.mock("@/modelManagement/providers/ProviderRegistry", () => ({
  ProviderRegistry: {
    getInstance: () => ({
      list: () => providers.slice(),
      get: (id: string) => providers.find((p) => p.id === id),
      remove: providerRemoveMock,
      onChange: (fn: () => void) => {
        providerListeners.add(fn);
        return () => providerListeners.delete(fn);
      },
    }),
  },
}));

jest.mock("@/modelManagement/registry/ModelRegistry", () => ({
  ModelRegistry: {
    getInstance: () => ({
      list: () => registry.slice(),
      onChange: (fn: () => void) => {
        registryListeners.add(fn);
        return () => registryListeners.delete(fn);
      },
    }),
  },
}));

// ConfirmModal opens a Modal subclass with a React tree — out of scope for
// these tests; we replace it with a constructor that records calls and a
// no-op `open()`.
jest.mock("@/components/modals/ConfirmModal", () => ({
  ConfirmModal: jest.fn().mockImplementation(function (_app: unknown, onConfirm: () => void) {
    this.onConfirm = onConfirm;
    this.open = jest.fn(() => onConfirm());
  }),
}));

// Import after mocks are registered.

import { ByokPanel } from "@/modelManagement/ui/tabs/ByokPanel";

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "anthropic",
    kind: "builtin",
    displayName: "Anthropic",
    type: "anthropic",
    addedAt: 1,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    addedAt: 1,
    ...overrides,
  };
}

const fakeApp = {} as never;

describe("ByokPanel", () => {
  beforeEach(() => {
    ensureLoadedMock.mockClear();
    refreshMock.mockClear();
    providerRemoveMock.mockClear();
    providers = [];
    registry = [];
    providerListeners.clear();
    registryListeners.clear();
    getMetaMock.mockReturnValue({ fetchedAt: Date.now(), source: "disk" });
  });

  it("calls ensureLoaded() on mount", async () => {
    render(<ByokPanel app={fakeApp} />);
    await waitFor(() => expect(ensureLoadedMock).toHaveBeenCalledTimes(1));
  });

  it("renders the empty state when no providers are configured", async () => {
    render(<ByokPanel app={fakeApp} />);
    // Wait for the skeleton to swap out.
    await waitFor(() => expect(screen.getByText(/No providers configured yet\./i)).toBeTruthy());
    // Add provider CTA visible.
    expect(screen.getAllByRole("button", { name: /Add provider/i }).length).toBeGreaterThan(0);
  });

  it("renders provider sections in the populated state", async () => {
    providers = [
      makeProvider({}),
      makeProvider({
        id: "custom:local",
        kind: "custom",
        displayName: "Local Ollama",
        type: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
      }),
    ];
    registry = [
      makeEntry({}),
      makeEntry({
        providerId: "custom:local",
        modelId: "llama3.2",
        displayName: "llama3.2",
      }),
    ];

    render(<ByokPanel app={fakeApp} />);

    await waitFor(() => expect(screen.getByText("Anthropic")).toBeTruthy());
    expect(screen.getByText("Local Ollama")).toBeTruthy();
    expect(screen.getByText(/custom endpoint/i)).toBeTruthy();
    expect(screen.queryByTestId("byok-footer")).toBeNull();
  });

  it("hides providers with no registered models", async () => {
    providers = [
      makeProvider({}),
      makeProvider({
        id: "google",
        displayName: "Google",
        type: "google",
      }),
    ];
    registry = [makeEntry({})];

    render(<ByokPanel app={fakeApp} />);

    await waitFor(() => expect(screen.getByText("Anthropic")).toBeTruthy());
    expect(screen.queryByText("Google")).toBeNull();
  });

  it("filters model rows by search query", async () => {
    providers = [makeProvider({})];
    registry = [
      makeEntry({ modelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }),
      makeEntry({ modelId: "claude-opus-4-1", displayName: "Claude Opus 4.1" }),
    ];

    render(<ByokPanel app={fakeApp} />);
    await waitFor(() => expect(screen.getByText("Claude Opus 4.1")).toBeTruthy());

    const searchInput = screen.getByPlaceholderText("Filter models…");
    fireEvent.change(searchInput, { target: { value: "Opus" } });

    await waitFor(() => expect(screen.queryByText("Claude Sonnet 4.5")).toBeNull());
    expect(screen.getByText("Claude Opus 4.1")).toBeTruthy();
  });
});
