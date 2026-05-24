import type { VerificationResult } from "@/modelManagement/types/runtime";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";

const mockVerifyCredentials = jest.fn<Promise<VerificationResult>, [string, unknown]>();
const mockAddCatalogProvider = jest
  .fn<Promise<{ providerId: string; configuredModelIds: string[] }>, [unknown]>()
  .mockResolvedValue({ providerId: "p1", configuredModelIds: ["m1"] });
const mockSetApiKey = jest.fn().mockResolvedValue(undefined);
const mockGetApiKey = jest.fn().mockResolvedValue("existing-key");
const mockVerify = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockBulkSet = jest.fn().mockResolvedValue([]);
const mockEnableModel = jest.fn().mockResolvedValue(undefined);
const mockRemoveRefs = jest.fn().mockResolvedValue(undefined);
const mockGetProvider = jest.fn();

jest.mock("@/modelManagement/ui/ModelManagementContext", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocks the real `useModelManagement` hook; the name must match the export
  useModelManagement: () => ({
    adapters: { verifyCredentials: mockVerifyCredentials },
    setup: { byok: { addCatalogProvider: mockAddCatalogProvider } },
    providerRegistry: {
      setApiKey: mockSetApiKey,
      getApiKey: mockGetApiKey,
      verify: mockVerify,
      update: mockUpdate,
    },
    configuredModelRegistry: { bulkSet: mockBulkSet },
    backendConfigRegistry: { enableModel: mockEnableModel, removeRefs: mockRemoveRefs },
    coordinator: { removeProvider: jest.fn() },
    catalogService: { getProvider: mockGetProvider },
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
        configuredModelId: "cm1",
        providerId: "p1",
        info: {
          id: "claude-sonnet",
          displayName: "Claude Sonnet 4.5",
          limits: { context: 200000 },
        },
        configuredAt: 0,
      },
      {
        configuredModelId: "cm2",
        providerId: "p1",
        info: { id: "claude-opus", displayName: "Claude Opus 4.5" },
        configuredAt: 0,
      },
    ]),
  };
});
jest.mock("@/settings/model", () => {
  const jotai = jest.requireActual<typeof import("jotai")>("jotai");
  return { settingsStore: jotai.createStore() };
});
jest.mock("@/components/ui/password-input", () => ({
  PasswordInput: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <input data-testid="api-key" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

import type { CatalogProvider } from "@/modelManagement/types/catalog";
import { ConfigureProviderForm } from "./ConfigureProviderDialog";

beforeEach(() => jest.clearAllMocks());

const catalog: CatalogProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  providerType: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  models: {
    "claude-sonnet": {
      id: "claude-sonnet",
      displayName: "Claude Sonnet 4.5",
      limits: { context: 200000 },
      releaseDate: "2025-09-01",
    },
    "claude-opus": {
      id: "claude-opus",
      displayName: "Claude Opus 4.5",
      limits: { context: 200000 },
    },
  },
};

// Live catalog used by edit-mode tests: the two configured models plus a new
// chat model (claude-haiku) and a new embedding model (voyage-embed).
const editCatalog: CatalogProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  providerType: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  models: {
    "claude-sonnet": {
      id: "claude-sonnet",
      displayName: "Claude Sonnet 4.5",
      limits: { context: 200000 },
    },
    "claude-opus": { id: "claude-opus", displayName: "Claude Opus 4.5" },
    "claude-haiku": { id: "claude-haiku", displayName: "Claude Haiku 4.5" },
    "voyage-embed": { id: "voyage-embed", displayName: "Voyage Embed", isEmbedding: true },
  },
};

function selectModel(wireId: string): void {
  const row = screen.getByTestId(`catalog-row-${wireId}`);
  fireEvent.click(within(row).getByRole("checkbox"));
}

describe("ConfigureProviderForm (new mode)", () => {
  it("enables Verify & save only after verification and a model selection", async () => {
    mockVerifyCredentials.mockResolvedValue({ ok: true, checkedAt: 1 });
    render(<ConfigureProviderForm state={{ mode: "new", catalog }} onClose={jest.fn()} />);

    const save = screen.getByRole("button", { name: "Verify & save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    // Selecting a model alone is not enough — still unverified.
    selectModel("claude-sonnet");
    expect(save.hasAttribute("disabled")).toBe(true);

    // Once verification succeeds, both gates are satisfied.
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });

  it("calls addCatalogProvider with the catalog template and selected ids", async () => {
    mockVerifyCredentials.mockResolvedValue({ ok: true, checkedAt: 1 });
    const onClose = jest.fn();
    render(<ConfigureProviderForm state={{ mode: "new", catalog }} onClose={onClose} />);

    selectModel("claude-sonnet");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const save = screen.getByRole("button", { name: "Verify & save" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(mockAddCatalogProvider).toHaveBeenCalledTimes(1));
    expect(mockAddCatalogProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        template: catalog,
        displayName: "Anthropic",
        selectedWireModelIds: ["claude-sonnet"],
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows an error below the input when verification fails", async () => {
    mockVerifyCredentials.mockResolvedValue({ ok: false, message: "bad key", checkedAt: 1 });
    render(<ConfigureProviderForm state={{ mode: "new", catalog }} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("bad key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify & save" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  it("uses the catalog base URL as the input placeholder in new mode", () => {
    render(<ConfigureProviderForm state={{ mode: "new", catalog }} onClose={jest.fn()} />);
    expect(screen.getByPlaceholderText("https://api.anthropic.com")).toBeTruthy();
  });

  it("falls back to a known default endpoint for providers the catalog omits", async () => {
    // models.dev reports no `api` for OpenAI; the form fills the known default
    // so a blank Base URL still verifies and saves.
    const openai: CatalogProvider = {
      id: "openai",
      displayName: "OpenAI",
      providerType: "openai-compatible",
      models: { "gpt-5": { id: "gpt-5", displayName: "GPT-5" } },
    };
    mockVerifyCredentials.mockResolvedValue({ ok: true, checkedAt: 1 });
    const onClose = jest.fn();
    render(<ConfigureProviderForm state={{ mode: "new", catalog: openai }} onClose={onClose} />);

    // The known default is shown as the placeholder...
    expect(screen.getByPlaceholderText("https://api.openai.com/v1")).toBeTruthy();

    selectModel("gpt-5");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const save = screen.getByRole("button", { name: "Verify & save" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);

    // ...and persisted as the base URL when the field is left blank.
    await waitFor(() =>
      expect(mockAddCatalogProvider).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://api.openai.com/v1" })
      )
    );
  });
});

describe("ConfigureProviderForm (edit mode)", () => {
  it("verifies without persisting the API key (Test never writes the key)", async () => {
    mockVerifyCredentials.mockResolvedValue({ ok: true, checkedAt: 1 });
    render(
      <ConfigureProviderForm state={{ mode: "edit", providerId: "p1" }} onClose={jest.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(mockVerifyCredentials).toHaveBeenCalledTimes(1));
    // The already-saved key is re-tested via getApiKey, never re-written.
    expect(mockGetApiKey).toHaveBeenCalledWith("p1");
    expect(mockSetApiKey).not.toHaveBeenCalled();
  });

  it("removes de-selected models from every backend picker on save", async () => {
    mockBulkSet.mockResolvedValue(["cm1"]);
    const onClose = jest.fn();
    render(<ConfigureProviderForm state={{ mode: "edit", providerId: "p1" }} onClose={onClose} />);

    // Both models start checked; uncheck Claude Opus, then save changes.
    selectModel("claude-opus");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockRemoveRefs).toHaveBeenCalledWith(["cm2"]));
    expect(mockBulkSet).toHaveBeenCalledWith("p1", [
      expect.objectContaining({ id: "claude-sonnet" }),
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("auto-enrolls only newly added chat models — skips embeddings, never re-enables existing", async () => {
    // Live catalog adds a new chat model and a new embedding model on top of
    // the two already configured (claude-sonnet, claude-opus).
    mockGetProvider.mockReturnValue(editCatalog);
    // bulkSet returns ids 1:1 with input order (= selectedWireIds insertion
    // order: existing first, then the two newly checked).
    mockBulkSet.mockResolvedValue(["cm1", "cm2", "cm-haiku", "cm-embed"]);
    const onClose = jest.fn();
    render(<ConfigureProviderForm state={{ mode: "edit", providerId: "p1" }} onClose={onClose} />);

    selectModel("claude-haiku"); // new chat model
    selectModel("voyage-embed"); // new embedding model
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // The new chat model is enrolled into every default backend.
    for (const backend of ["chat", "opencode"]) {
      expect(mockEnableModel).toHaveBeenCalledWith(backend, "cm-haiku");
    }
    // The new embedding model is never enrolled (would fail in chat pickers).
    expect(mockEnableModel).not.toHaveBeenCalledWith(expect.anything(), "cm-embed");
    // Previously-configured models are never (re-)enrolled — a model the user
    // disabled on a backend must stay disabled across an edit-save.
    expect(mockEnableModel).not.toHaveBeenCalledWith(expect.anything(), "cm1");
    expect(mockEnableModel).not.toHaveBeenCalledWith(expect.anything(), "cm2");
  });

  it("Test verifies the edited base URL, not the persisted one", async () => {
    mockGetProvider.mockReturnValue(editCatalog);
    mockVerifyCredentials.mockResolvedValue({ ok: true, checkedAt: 1 });
    render(
      <ConfigureProviderForm state={{ mode: "edit", providerId: "p1" }} onClose={jest.fn()} />
    );

    const baseUrlInput = screen.getByPlaceholderText("https://api.anthropic.com");
    fireEvent.change(baseUrlInput, { target: { value: "https://proxy.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(mockVerifyCredentials).toHaveBeenCalled());
    const [providerType, ctx] = mockVerifyCredentials.mock.calls[0];
    expect(providerType).toBe("anthropic");
    expect((ctx as { provider: { baseUrl?: string } }).provider.baseUrl).toBe(
      "https://proxy.example.com"
    );
  });
});
