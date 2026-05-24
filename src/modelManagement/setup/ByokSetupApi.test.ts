/**
 * Tests for `ByokSetupApi.addCatalogProvider`.
 *
 * Real settings store + real registries. Keychain is mocked with the
 * same fake `app.secretStorage` shim used in `ProviderRegistry.test.ts`.
 */

import { resetSettings, getSettings } from "@/settings/model";
import { KeychainService } from "@/services/keychainService";

import { BackendConfigRegistry } from "@/modelManagement/backends/BackendConfigRegistry";
import { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";
import { ProviderAdapterRegistry } from "@/modelManagement/providers/adapters/ProviderAdapterRegistry";
import type { CatalogProvider } from "@/modelManagement/types/catalog";

import { ByokSetupApi, BYOK_DEFAULT_AUTO_ENROLL } from "./ByokSetupApi";

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

const ANTHROPIC_CATALOG: CatalogProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  providerType: "anthropic",
  models: {
    "claude-sonnet-4-5": { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
    "claude-opus-4-5": { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
    "claude-haiku-4-5": { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  },
};

describe("ByokSetupApi.addCatalogProvider", () => {
  let api: ByokSetupApi;
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
    api = new ByokSetupApi(providers, models, backends);
  });

  it("creates a BYOK provider, snapshots models, stores key, and auto-enrolls into chat + opencode", async () => {
    const result = await api.addCatalogProvider({
      template: ANTHROPIC_CATALOG,
      displayName: "My Anthropic",
      apiKey: "sk-ant-test",
      selectedWireModelIds: ["claude-sonnet-4-5", "claude-opus-4-5"],
    });

    expect(result.configuredModelIds).toHaveLength(2);

    const provider = providers.get(result.providerId)!;
    expect(provider.providerType).toBe("anthropic");
    expect(provider.displayName).toBe("My Anthropic");
    expect(provider.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(provider.origin).toEqual({ kind: "byok", catalogProviderId: "anthropic" });
    expect(provider.apiKeyKeychainId).toBeTruthy();
    expect(await providers.getApiKey(result.providerId)).toBe("sk-ant-test");

    const provModels = models.listByProvider(result.providerId);
    expect(provModels.map((m) => m.info.id).sort()).toEqual([
      "claude-opus-4-5",
      "claude-sonnet-4-5",
    ]);

    for (const backend of BYOK_DEFAULT_AUTO_ENROLL) {
      expect(backends.get(backend).enabledModels.sort()).toEqual(
        [...result.configuredModelIds].sort()
      );
    }
  });

  it("baseUrl override takes precedence over the catalog default", async () => {
    const result = await api.addCatalogProvider({
      template: ANTHROPIC_CATALOG,
      displayName: "Anthropic via proxy",
      baseUrl: "https://proxy.example.com/v1",
      apiKey: "sk-ant-test",
      selectedWireModelIds: ["claude-sonnet-4-5"],
    });
    expect(providers.get(result.providerId)!.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("skips auto-enrollment when autoEnrollIn is the empty list", async () => {
    const result = await api.addCatalogProvider({
      template: ANTHROPIC_CATALOG,
      displayName: "Anthropic",
      apiKey: "sk-ant",
      selectedWireModelIds: ["claude-sonnet-4-5"],
      autoEnrollIn: [],
    });
    expect(result.configuredModelIds).toHaveLength(1);
    expect(getSettings().backends).toEqual({});
  });

  it("ignores wire ids that aren't in the template's models map", async () => {
    const result = await api.addCatalogProvider({
      template: ANTHROPIC_CATALOG,
      displayName: "Anthropic",
      apiKey: "sk-ant",
      selectedWireModelIds: ["claude-sonnet-4-5", "made-up-model"],
    });
    expect(result.configuredModelIds).toHaveLength(1);
    expect(models.listByProvider(result.providerId)[0].info.id).toBe("claude-sonnet-4-5");
  });

  it("configures embedding models but does not auto-enroll them into chat backends", async () => {
    const mixedCatalog: CatalogProvider = {
      id: "openai",
      displayName: "OpenAI",
      defaultBaseUrl: "https://api.openai.com/v1",
      providerType: "openai-compatible",
      models: {
        "gpt-4o": { id: "gpt-4o", displayName: "GPT-4o" },
        "text-embedding-3-small": {
          id: "text-embedding-3-small",
          displayName: "text-embedding-3-small",
          isEmbedding: true,
        },
      },
    };

    const result = await api.addCatalogProvider({
      template: mixedCatalog,
      displayName: "OpenAI",
      apiKey: "sk-test",
      selectedWireModelIds: ["gpt-4o", "text-embedding-3-small"],
    });

    // Both models are configured (snapshotted under the provider)...
    expect(result.configuredModelIds).toHaveLength(2);
    const embeddingModel = models
      .listByProvider(result.providerId)
      .find((m) => m.info.id === "text-embedding-3-small")!;
    const chatModel = models.listByProvider(result.providerId).find((m) => m.info.id === "gpt-4o")!;

    // ...but only the chat model is enrolled in the chat/agent pickers.
    for (const backend of BYOK_DEFAULT_AUTO_ENROLL) {
      const enabled = backends.get(backend).enabledModels;
      expect(enabled).toContain(chatModel.configuredModelId);
      expect(enabled).not.toContain(embeddingModel.configuredModelId);
    }
  });

  it("does not call setApiKey when apiKey is omitted (no-key providers)", async () => {
    const ollamaLike: CatalogProvider = {
      id: "self-hosted",
      displayName: "Self Hosted",
      defaultBaseUrl: "http://localhost:11434/v1",
      providerType: "openai-compatible",
      models: { "llama-3": { id: "llama-3", displayName: "Llama 3" } },
    };
    const result = await api.addCatalogProvider({
      template: ollamaLike,
      displayName: "Local",
      selectedWireModelIds: ["llama-3"],
    });
    const provider = providers.get(result.providerId)!;
    expect(provider.apiKeyKeychainId).toBeNull();
    expect(await providers.getApiKey(result.providerId)).toBeNull();
  });
});
