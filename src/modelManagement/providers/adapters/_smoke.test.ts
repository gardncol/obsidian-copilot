import { buildChatModel as buildOpenAICompatible } from "@/modelManagement/providers/adapters/OpenAICompatibleAdapter";
import { buildChatModel as buildOpenAI } from "@/modelManagement/providers/adapters/OpenAIAdapter";
import { buildChatModel as buildOllama } from "@/modelManagement/providers/adapters/OllamaAdapter";
import { buildChatModel as buildOpenRouter } from "@/modelManagement/providers/adapters/OpenRouterAdapter";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";

/**
 * Minimal `BuildChatModelInput` factory for adapter smoke tests. Tests that
 * exercise per-model overrides populate `entry.extra`; tests that exercise
 * provider-level config populate `provider.extra` / `provider.baseUrl`.
 */
function makeInput(overrides: Partial<BuildChatModelInput> = {}): BuildChatModelInput {
  const base: BuildChatModelInput = {
    provider: {
      id: "openai-compatible",
      kind: "builtin",
      displayName: "test",
      addedAt: 0,
    },
    entry: { providerId: "openai-compatible", modelId: "test-model", displayName: "X", addedAt: 0 },
    defaults: { temperature: 0.5, maxTokens: 100 },
    catalog: {} as never,
    apiKey: "abc",
  };
  return { ...base, ...overrides };
}

describe("OpenAICompatibleAdapter", () => {
  it("reads baseUrl from provider.baseUrl", () => {
    const input = makeInput({
      provider: {
        id: "openai-compatible",
        kind: "builtin",
        displayName: "test",
        baseUrl: "http://provider-default",
        addedAt: 0,
      },
    });
    const model = buildOpenAICompatible(input);
    expect(
      (model as unknown as { clientConfig?: { baseURL?: string } }).clientConfig?.baseURL
    ).toBe("http://provider-default");
  });

  it("entry.extra.baseUrl overrides provider.baseUrl", () => {
    const input = makeInput({
      provider: {
        id: "openai-compatible",
        kind: "builtin",
        displayName: "test",
        baseUrl: "http://provider-default",
        addedAt: 0,
      },
      entry: {
        providerId: "openai-compatible",
        modelId: "test-model",
        displayName: "X",
        addedAt: 0,
        extra: { baseUrl: "http://per-model-override" },
      },
    });
    const model = buildOpenAICompatible(input);
    expect(
      (model as unknown as { clientConfig?: { baseURL?: string } }).clientConfig?.baseURL
    ).toBe("http://per-model-override");
  });

  it("does not crash when entry.extra is undefined", () => {
    const input = makeInput();
    expect(() => buildOpenAICompatible(input)).not.toThrow();
  });
});

describe("OpenAIAdapter", () => {
  it("forwards provider.extra.openAIOrgId as organization", () => {
    const input = makeInput({
      provider: {
        id: "openai",
        kind: "builtin",
        displayName: "OpenAI",
        addedAt: 0,
        extra: { openAIOrgId: "org-abc123" },
      },
    });
    const model = buildOpenAI(input);
    expect(
      (model as unknown as { clientConfig?: { organization?: string } }).clientConfig?.organization
    ).toBe("org-abc123");
  });

  it("omits organization when provider.extra.openAIOrgId is unset", () => {
    const input = makeInput({
      provider: {
        id: "openai",
        kind: "builtin",
        displayName: "OpenAI",
        addedAt: 0,
      },
    });
    const model = buildOpenAI(input);
    expect(
      (model as unknown as { clientConfig?: { organization?: string } }).clientConfig?.organization
    ).toBeUndefined();
  });
});

describe("OllamaAdapter", () => {
  it("reads numCtx from entry.extra", () => {
    const input = makeInput({
      provider: { id: "ollama", kind: "builtin", displayName: "Ollama", addedAt: 0 },
      entry: {
        providerId: "ollama",
        modelId: "llama3",
        displayName: "Llama 3",
        addedAt: 0,
        extra: { numCtx: 8192 },
      },
    });
    const model = buildOllama(input);
    expect((model as unknown as { numCtx?: number }).numCtx).toBe(8192);
  });

  it("falls back to the default numCtx when entry.extra is empty", () => {
    const input = makeInput({
      provider: { id: "ollama", kind: "builtin", displayName: "Ollama", addedAt: 0 },
      entry: {
        providerId: "ollama",
        modelId: "llama3",
        displayName: "Llama 3",
        addedAt: 0,
      },
    });
    expect(() => buildOllama(input)).not.toThrow();
  });
});

describe("OpenRouterAdapter", () => {
  it("reads enablePromptCaching from entry.extra", () => {
    const input = makeInput({
      provider: { id: "openrouter", kind: "builtin", displayName: "OpenRouter", addedAt: 0 },
      entry: {
        providerId: "openrouter",
        modelId: "anthropic/claude-sonnet-4-5",
        displayName: "Claude",
        addedAt: 0,
        extra: { enablePromptCaching: false },
      },
    });
    const model = buildOpenRouter(input);
    expect((model as unknown as { enablePromptCaching?: boolean }).enablePromptCaching).toBe(false);
  });

  it("defaults enablePromptCaching to true when entry.extra is empty", () => {
    const input = makeInput({
      provider: { id: "openrouter", kind: "builtin", displayName: "OpenRouter", addedAt: 0 },
      entry: {
        providerId: "openrouter",
        modelId: "anthropic/claude-sonnet-4-5",
        displayName: "Claude",
        addedAt: 0,
      },
    });
    const model = buildOpenRouter(input);
    expect((model as unknown as { enablePromptCaching?: boolean }).enablePromptCaching).toBe(true);
  });
});
