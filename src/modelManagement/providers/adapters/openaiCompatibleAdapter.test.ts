/**
 * Tests for `openaiCompatibleAdapter.verifyCredentials`.
 */

import { openaiCompatibleAdapter } from "./openaiCompatibleAdapter";

jest.mock("./verifyViaListModels", () => ({
  verifyViaListModels: jest.fn(),
}));

import { verifyViaListModels } from "./verifyViaListModels";

import type { Provider } from "@/modelManagement/types/persisted";

const mockVerify = verifyViaListModels as jest.MockedFunction<typeof verifyViaListModels>;

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    providerId: "p1",
    providerType: "openai-compatible",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    origin: { kind: "byok" },
    addedAt: 0,
    apiKeyKeychainId: null,
    ...overrides,
  };
}

describe("openaiCompatibleAdapter.verifyCredentials", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    mockVerify.mockResolvedValue({ ok: true, checkedAt: 1 });
  });

  it("returns missing_base_url when baseUrl is unset", async () => {
    const result = await openaiCompatibleAdapter.verifyCredentials({
      provider: provider({ baseUrl: undefined }),
      apiKey: "sk-openai",
      extras: {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_base_url");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns missing_base_url when baseUrl is only whitespace", async () => {
    const result = await openaiCompatibleAdapter.verifyCredentials({
      provider: provider({ baseUrl: "   " }),
      apiKey: "sk-openai",
      extras: {},
    });
    expect(result.code).toBe("missing_base_url");
  });

  it("sends Bearer auth when apiKey is set", async () => {
    await openaiCompatibleAdapter.verifyCredentials({
      provider: provider(),
      apiKey: "sk-openai",
      extras: {},
    });
    expect(mockVerify).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      Authorization: "Bearer sk-openai",
    });
  });

  it("omits Authorization header for keyless providers (Ollama / LMStudio)", async () => {
    await openaiCompatibleAdapter.verifyCredentials({
      provider: provider({ baseUrl: "http://localhost:11434/v1" }),
      apiKey: null,
      extras: {},
    });
    const headers = mockVerify.mock.calls[0][1];
    expect(headers).not.toHaveProperty("Authorization");
    expect(mockVerify).toHaveBeenCalledWith("http://localhost:11434/v1/models", {});
  });

  it("adds OpenAI-Organization header when extras.openAIOrgId is set", async () => {
    await openaiCompatibleAdapter.verifyCredentials({
      provider: provider(),
      apiKey: "sk-openai",
      extras: { openAIOrgId: "org-abc" },
    });
    expect(mockVerify).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        Authorization: "Bearer sk-openai",
        "OpenAI-Organization": "org-abc",
      })
    );
  });

  it("strips trailing slash from baseUrl", async () => {
    await openaiCompatibleAdapter.verifyCredentials({
      provider: provider({ baseUrl: "https://example.test/v1/" }),
      apiKey: "k",
      extras: {},
    });
    expect(mockVerify).toHaveBeenCalledWith("https://example.test/v1/models", expect.any(Object));
  });
});
