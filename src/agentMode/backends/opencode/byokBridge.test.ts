/**
 * `byokBridge` unit tests.
 *
 * `buildByokOpencodeProviderConfig` shapes the BYOK provider + model
 * registries into the OpenCode `provider.<id>` slice. Covers built-in and
 * custom providers, the no-key skip rule for built-ins, the keep-anyway
 * rule for custom providers, and `models` registration from `ModelRegistry`.
 */
import { buildByokOpencodeProviderConfig } from "./byokBridge";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

type ProviderConfigStub = {
  id: string;
  kind: "builtin" | "custom";
  displayName: string;
  type: string;
  baseUrl?: string;
  apiKeyRef?: { kind: "inline"; value: string } | null;
  addedAt: number;
};

type RegistryEntryStub = {
  providerId: string;
  modelId: string;
  displayName: string;
  addedAt: number;
};

let mockProviders: ProviderConfigStub[] = [];
let mockRegistry: RegistryEntryStub[] = [];

jest.mock("@/modelManagement", () => ({
  ProviderRegistry: {
    getInstance: () => ({
      list: () => mockProviders.slice(),
    }),
  },
  ModelRegistry: {
    getInstance: () => ({
      list: (filter?: { providerId?: string }) =>
        filter?.providerId
          ? mockRegistry.filter((e) => e.providerId === filter.providerId)
          : mockRegistry.slice(),
    }),
  },
  getProviderApiKeySync: (id: string) => {
    const p = mockProviders.find((x) => x.id === id);
    if (!p?.apiKeyRef) return null;
    return p.apiKeyRef.kind === "inline" ? p.apiKeyRef.value : null;
  },
}));

beforeEach(() => {
  mockProviders = [];
  mockRegistry = [];
});

async function loadRegistries() {
  const mm = await import("@/modelManagement");
  return {
    providerRegistry: mm.ProviderRegistry.getInstance(),
    modelRegistry: mm.ModelRegistry.getInstance(),
  };
}

describe("buildByokOpencodeProviderConfig", () => {
  it("registers a built-in provider as { options: { apiKey } } under its canonical id", async () => {
    mockProviders = [
      {
        id: "anthropic",
        kind: "builtin",
        displayName: "Anthropic",
        type: "anthropic",
        apiKeyRef: { kind: "inline", value: "sk-ant-xxx" },
        addedAt: 1,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result).toEqual({
      anthropic: { options: { apiKey: "sk-ant-xxx" } },
    });
  });

  it("registers `openai-compatible` built-ins under their own canonical id (not collapsed onto `openai`)", async () => {
    mockProviders = [
      {
        id: "openai",
        kind: "builtin",
        displayName: "OpenAI",
        type: "openai-compatible",
        apiKeyRef: { kind: "inline", value: "sk-oai" },
        addedAt: 1,
      },
      {
        id: "openrouter",
        kind: "builtin",
        displayName: "OpenRouter",
        type: "openai-compatible",
        apiKeyRef: { kind: "inline", value: "sk-or" },
        addedAt: 2,
      },
      {
        id: "groq",
        kind: "builtin",
        displayName: "Groq",
        type: "openai-compatible",
        apiKeyRef: { kind: "inline", value: "gsk-x" },
        addedAt: 3,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result).toEqual({
      openai: { options: { apiKey: "sk-oai" } },
      openrouter: { options: { apiKey: "sk-or" } },
      groq: { options: { apiKey: "gsk-x" } },
    });
  });

  it("registers a custom provider with npm + baseURL + apiKey under its custom: id", async () => {
    mockProviders = [
      {
        id: "custom:abc",
        kind: "custom",
        displayName: "Local Ollama",
        type: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKeyRef: { kind: "inline", value: "ollama-key" },
        addedAt: 1,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result).toEqual({
      "custom:abc": {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Ollama",
        options: {
          baseURL: "http://localhost:11434/v1",
          apiKey: "ollama-key",
        },
      },
    });
  });

  it("keeps custom providers without an API key (local endpoints)", async () => {
    mockProviders = [
      {
        id: "custom:local",
        kind: "custom",
        displayName: "LM Studio",
        type: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        apiKeyRef: null,
        addedAt: 1,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result["custom:local"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "LM Studio",
      options: { baseURL: "http://localhost:1234/v1" },
    });
  });

  it("drops built-in providers with no API key (would be useless)", async () => {
    mockProviders = [
      {
        id: "groq",
        kind: "builtin",
        displayName: "Groq",
        type: "openai-compatible",
        apiKeyRef: null,
        addedAt: 1,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result).toEqual({});
  });

  it("registers BYOK registry models under the resolved provider's `models` map", async () => {
    mockProviders = [
      {
        id: "anthropic",
        kind: "builtin",
        displayName: "Anthropic",
        type: "anthropic",
        apiKeyRef: { kind: "inline", value: "sk-ant" },
        addedAt: 1,
      },
    ];
    mockRegistry = [
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        addedAt: 2,
      },
      {
        providerId: "anthropic",
        modelId: "claude-haiku",
        displayName: "Claude Haiku",
        addedAt: 3,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result.anthropic).toEqual({
      options: { apiKey: "sk-ant" },
      models: { "claude-sonnet-4-5": {}, "claude-haiku": {} },
    });
  });

  it("registers models for custom providers under the `custom:` id", async () => {
    mockProviders = [
      {
        id: "custom:abc",
        kind: "custom",
        displayName: "Local Ollama",
        type: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKeyRef: null,
        addedAt: 1,
      },
    ];
    mockRegistry = [
      { providerId: "custom:abc", modelId: "llama3:8b", displayName: "Llama 3 8B", addedAt: 2 },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result["custom:abc"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Local Ollama",
      options: { baseURL: "http://localhost:11434/v1" },
      models: { "llama3:8b": {} },
    });
  });

  it("omits the `models` field when no registry entries exist for the provider", async () => {
    mockProviders = [
      {
        id: "anthropic",
        kind: "builtin",
        displayName: "Anthropic",
        type: "anthropic",
        apiKeyRef: { kind: "inline", value: "sk-ant" },
        addedAt: 1,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result.anthropic).not.toHaveProperty("models");
  });

  it("does not leak registry entries that belong to a different provider", async () => {
    mockProviders = [
      {
        id: "anthropic",
        kind: "builtin",
        displayName: "Anthropic",
        type: "anthropic",
        apiKeyRef: { kind: "inline", value: "sk-ant" },
        addedAt: 1,
      },
    ];
    mockRegistry = [
      {
        providerId: "openai",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        addedAt: 2,
      },
    ];
    const { providerRegistry, modelRegistry } = await loadRegistries();
    const result = buildByokOpencodeProviderConfig(providerRegistry, modelRegistry);
    expect(result.anthropic).not.toHaveProperty("models");
  });
});
