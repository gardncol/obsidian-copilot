/**
 * Tests for `ModelManagementCoordinator.removeProvider`.
 *
 * Exercises the cross-slice cascade: backend refs → configured models →
 * provider row + keychain.
 */

import { resetSettings, getSettings } from "@/settings/model";
import { KeychainService } from "@/services/keychainService";

import { BackendConfigRegistry } from "@/modelManagement/backends/BackendConfigRegistry";
import { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";
import { ProviderAdapterRegistry } from "@/modelManagement/providers/adapters/ProviderAdapterRegistry";

import { ModelManagementCoordinator } from "./createModelManagement";

import type { App } from "obsidian";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

function makeFakeApp(): App {
  const secrets = new Map<string, string>();
  return {
    secretStorage: {
      setSecret: (id: string, value: string) => {
        secrets.set(id, value);
      },
      getSecret: (id: string) => (secrets.has(id) ? secrets.get(id)! : null),
      listSecrets: () => Array.from(secrets.keys()),
      deleteSecret: (id: string) => {
        secrets.delete(id);
      },
    },
    vault: { adapter: {} },
  } as unknown as App;
}

describe("ModelManagementCoordinator.removeProvider", () => {
  let coordinator: ModelManagementCoordinator;
  let providers: ProviderRegistry;
  let models: ConfiguredModelRegistry;
  let backends: BackendConfigRegistry;

  beforeEach(() => {
    resetSettings();
    KeychainService.resetInstance();
    const app = makeFakeApp();
    KeychainService.getInstance(app);
    providers = new ProviderRegistry(app, new ProviderAdapterRegistry());
    models = new ConfiguredModelRegistry();
    backends = new BackendConfigRegistry(providers, models);
    coordinator = new ModelManagementCoordinator(providers, models, backends);
  });

  it("cascades through backends, models, provider, and clears the keychain", async () => {
    const providerId = await providers.add({
      providerType: "anthropic",
      displayName: "Anthropic",
      origin: { kind: "byok" },
    });
    await providers.setApiKey(providerId, "sk-ant-test");
    const id1 = await models.add({
      providerId,
      info: { id: "claude-sonnet-4-5", displayName: "Sonnet" },
    });
    const id2 = await models.add({
      providerId,
      info: { id: "claude-opus-4-5", displayName: "Opus" },
    });
    await backends.setEnabledModels("chat", [id1, id2]);
    await backends.setDefaultModel("chat", id1);
    await backends.setEnabledModels("opencode", [id2]);

    await coordinator.removeProvider(providerId);

    expect(providers.get(providerId)).toBeUndefined();
    expect(models.listByProvider(providerId)).toHaveLength(0);
    expect(backends.get("chat").enabledModels).toEqual([]);
    expect(backends.get("chat").defaultModel).toBeNull();
    expect(backends.get("opencode").enabledModels).toEqual([]);
    expect(await providers.getApiKey(providerId)).toBeNull();
  });

  it("only removes models and refs belonging to the target provider", async () => {
    const idA = await providers.add({
      providerType: "anthropic",
      displayName: "A",
      origin: { kind: "byok" },
    });
    const idB = await providers.add({
      providerType: "anthropic",
      displayName: "B",
      origin: { kind: "byok" },
    });
    const aModel = await models.add({
      providerId: idA,
      info: { id: "model-a", displayName: "A1" },
    });
    const bModel = await models.add({
      providerId: idB,
      info: { id: "model-b", displayName: "B1" },
    });
    await backends.setEnabledModels("chat", [aModel, bModel]);

    await coordinator.removeProvider(idA);

    expect(providers.get(idB)).toBeDefined();
    expect(models.listByProvider(idB)).toHaveLength(1);
    expect(backends.get("chat").enabledModels).toEqual([bModel]);
  });

  it("is safe for a provider that has no configured models", async () => {
    const providerId = await providers.add({
      providerType: "google",
      displayName: "Empty",
      origin: { kind: "byok" },
    });
    await coordinator.removeProvider(providerId);
    expect(providers.get(providerId)).toBeUndefined();
    expect(getSettings().backends).toEqual({});
  });
});
