import { buildChatModel as buildOpenAICompatible } from "@/modelManagement/providers/adapters/OpenAICompatibleAdapter";
import type { BuildChatModelInput } from "@/modelManagement/chatModel/ChatModelFactory";

describe("smoke", () => {
  it("instantiates ChatOpenAI", () => {
    const input: BuildChatModelInput = {
      provider: { id: "openai-compatible", kind: "builtin", displayName: "test", addedAt: 0 },
      entry: { providerId: "openai-compatible", modelId: "x", displayName: "X", addedAt: 0 },
      defaults: { temperature: 0.5, maxTokens: 100 },
      catalog: {} as never,
      apiKey: "abc",
      legacyModel: {
        name: "test-model",
        provider: "openai-compatible",
        enabled: true,
        baseUrl: "http://test",
      },
    };
    const model = buildOpenAICompatible(input);
    // The clientConfig.baseURL is where the baseUrl ends up.
    expect(
      (model as unknown as { clientConfig?: { baseURL?: string } }).clientConfig?.baseURL
    ).toBe("http://test");
  });
});
