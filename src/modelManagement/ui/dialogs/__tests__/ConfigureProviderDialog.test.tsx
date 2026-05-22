/**
 * `ConfigureProviderDialog` tests — covers state transitions and the
 * carve-outs from §5.2.
 *
 * Scope (M5):
 *   - `new-byok`: shows API key field + base URL (read-only); no Availability row.
 *   - `new-custom`: shows display name + type radio + editable base URL.
 *   - `edit`: shows Remove provider button; ✓ Verified badge when
 *     `lastVerifiedAt` is set.
 *   - Save in a new state calls `onSave` with the assembled payload.
 */
import { ConfigureProviderDialog } from "@/modelManagement/ui/dialogs/ConfigureProviderDialog";
import type { ProviderConfig, RegistryEntry } from "@/modelManagement/types";
import type { CatalogProvider } from "@/modelManagement/catalog/modelsCatalog.types";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

// Stub the catalog service singleton — none of the tests hit disk or the
// network. Each test seeds a small per-provider catalog via the
// `catalog` prop, so the singleton is only used by paths that fall back
// to it (none here).
jest.mock("@/modelManagement/catalog/ModelCatalogService", () => ({
  ModelCatalogService: {
    getInstance: () => ({
      ensureLoaded: jest.fn().mockResolvedValue(undefined),
      getProvider: () => undefined,
    }),
  },
}));

function makeCatalogProvider(
  id: string,
  entries: Array<Partial<{ id: string; name: string; context: number; release_date: string }>>
): CatalogProvider {
  const models: CatalogProvider["models"] = {};
  for (const e of entries) {
    const mid = e.id ?? "model";
    models[mid] = {
      id: mid,
      name: e.name ?? mid,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: e.context ?? 200_000, output: 8000 },
      release_date: e.release_date,
    };
  }
  return { id, name: id, env: [], models };
}

function makeCatalog(
  byId: Record<string, CatalogProvider>
): React.ComponentProps<typeof ConfigureProviderDialog>["catalog"] {
  return {
    ensureLoaded: jest.fn().mockResolvedValue(undefined),
    getProvider: (id: string) => byId[id],
  };
}

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

const defaultTest = jest.fn().mockResolvedValue({ ok: true, verifiedAt: 1_700_000_000 });

describe("ConfigureProviderDialog", () => {
  it("new-byok: shows API key field and editable base URL; no Availability row", async () => {
    const catalog = makeCatalog({
      anthropic: makeCatalogProvider("anthropic", [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      ]),
    });
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        state="new-byok"
        providerId="anthropic"
        builtinDisplayName="Anthropic"
        onTest={defaultTest}
        onSave={jest.fn()}
        catalog={catalog}
      />
    );

    expect(screen.getByTestId("configure-api-key")).toBeTruthy();
    const baseUrl = screen.getByTestId("configure-base-url");
    // Base URL is editable for built-ins so users can route through proxies.
    expect(baseUrl.getAttribute("readonly")).toBeNull();
    expect(baseUrl.getAttribute("disabled")).toBeNull();

    // Custom-extras section MUST NOT render in new-byok.
    expect(screen.queryByTestId("configure-custom-extras")).toBeNull();

    // No availability row — search for "availability" string anywhere.
    expect(screen.queryByText(/availability/i)).toBeNull();
  });

  it("new-custom: shows display name + type radio + editable base URL", () => {
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        state="new-custom"
        onTest={defaultTest}
        onSave={jest.fn()}
        catalog={makeCatalog({})}
      />
    );

    expect(screen.getByTestId("configure-custom-extras")).toBeTruthy();
    expect(screen.getByTestId("configure-display-name")).toBeTruthy();
    expect(screen.getByTestId("configure-type-openai-compatible")).toBeTruthy();
    expect(screen.getByTestId("configure-type-anthropic")).toBeTruthy();
    expect(screen.getByTestId("configure-type-google")).toBeTruthy();
    const baseUrl = screen.getByTestId("configure-base-url");
    expect(baseUrl.getAttribute("readonly")).toBeNull();
  });

  it("edit: shows Remove provider button + 'Last verified' helper when lastVerifiedAt is set", () => {
    const provider = makeProvider({
      lastVerifiedAt: 1_700_000_000,
    });
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        state="edit"
        providerId={provider.id}
        existingProvider={provider}
        existingEntries={[makeEntry()]}
        onTest={defaultTest}
        onSave={jest.fn()}
        onRemoveProvider={jest.fn()}
        catalog={makeCatalog({
          anthropic: makeCatalogProvider("anthropic", [
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          ]),
        })}
      />
    );

    expect(screen.getByTestId("configure-remove-provider")).toBeTruthy();
    // Historic lastVerifiedAt no longer auto-credits; user must re-test.
    expect(screen.queryByTestId("configure-verified")).toBeNull();
    expect(screen.getByTestId("configure-last-verified")).toBeTruthy();
  });

  it("edit: hides the ✓ Verified badge when never verified", () => {
    const provider = makeProvider({ lastVerifiedAt: undefined });
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        state="edit"
        providerId={provider.id}
        existingProvider={provider}
        existingEntries={[]}
        onTest={defaultTest}
        onSave={jest.fn()}
        onRemoveProvider={jest.fn()}
        catalog={makeCatalog({})}
      />
    );

    expect(screen.queryByTestId("configure-verified")).toBeNull();
    expect(screen.queryByTestId("configure-last-verified")).toBeNull();
  });

  it("save in new-byok calls onSave with the selected entries", async () => {
    const onSave = jest.fn();
    const onOpenChange = jest.fn();
    const catalog = makeCatalog({
      anthropic: makeCatalogProvider("anthropic", [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
      ]),
    });
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={onOpenChange}
        state="new-byok"
        providerId="anthropic"
        builtinDisplayName="Anthropic"
        onTest={defaultTest}
        onSave={onSave}
        catalog={catalog}
      />
    );

    // Type a key.
    fireEvent.change(screen.getByTestId("configure-api-key"), {
      target: { value: "sk-test-key" },
    });

    // Check Claude Sonnet 4.5.
    const sonnetRow = screen.getByTestId("catalog-row-anthropic-claude-sonnet-4-5");
    const checkbox = sonnetRow.querySelector("button[role='checkbox']") as HTMLElement;
    fireEvent.click(checkbox);

    // Save is gated on a successful Test — run it first.
    await act(async () => {
      fireEvent.click(screen.getByTestId("configure-test-key"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("configure-verify-save"));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0] as {
      providerId: string;
      providerConfig: ProviderConfig;
      selectedEntries: Array<{
        modelId: string;
      }>;
    };
    expect(payload.providerId).toBe("anthropic");
    expect(payload.providerConfig.id).toBe("anthropic");
    expect(payload.providerConfig.kind).toBe("builtin");
    expect(payload.providerConfig.apiKeyRef).toEqual({ kind: "inline", value: "sk-test-key" });
    expect(payload.selectedEntries).toHaveLength(1);
    expect(payload.selectedEntries[0].modelId).toBe("claude-sonnet-4-5");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("verify error decorates the dialog with an inline message", async () => {
    const onTest = jest
      .fn()
      .mockResolvedValue({ ok: false, error: "401 Unauthorized", verifiedAt: 0 });
    const catalog = makeCatalog({
      anthropic: makeCatalogProvider("anthropic", [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      ]),
    });
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        state="new-byok"
        providerId="anthropic"
        builtinDisplayName="Anthropic"
        onTest={onTest}
        onSave={jest.fn()}
        catalog={catalog}
      />
    );

    fireEvent.change(screen.getByTestId("configure-api-key"), {
      target: { value: "sk-bad" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("configure-test-key"));
    });

    const errorEl = screen.getByTestId("configure-test-error");
    expect(errorEl.textContent).toContain("401 Unauthorized");
  });

  it("edit state shows a kebab on registered rows", () => {
    const provider = makeProvider({});
    const entry = makeEntry({});
    const catalog = makeCatalog({
      anthropic: makeCatalogProvider("anthropic", [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
      ]),
    });
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={jest.fn()}
        state="edit"
        providerId={provider.id}
        existingProvider={provider}
        existingEntries={[entry]}
        onTest={defaultTest}
        onSave={jest.fn()}
        onRemoveProvider={jest.fn()}
        catalog={catalog}
      />
    );

    expect(screen.getByLabelText("More actions for Claude Sonnet 4.5")).toBeTruthy();
    // Opus is not registered, so no kebab.
    const opusRow = screen.getByTestId("catalog-row-anthropic-claude-opus-4-1");
    expect(within(opusRow).queryByLabelText(/More actions/)).toBeNull();
  });

  it("Remove provider button invokes the callback", async () => {
    const onRemoveProvider = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <ConfigureProviderDialog
        open={true}
        onOpenChange={onOpenChange}
        state="edit"
        providerId="anthropic"
        existingProvider={makeProvider()}
        existingEntries={[]}
        onTest={defaultTest}
        onSave={jest.fn()}
        onRemoveProvider={onRemoveProvider}
        catalog={makeCatalog({})}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("configure-remove-provider"));
    });

    expect(onRemoveProvider).toHaveBeenCalledWith("anthropic");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
