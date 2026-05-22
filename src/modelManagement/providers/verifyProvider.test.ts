import { verifyProvider } from "@/modelManagement/providers/verifyProvider";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn(),
}));

const mockFetch = jest.fn();
jest.mock("@/utils", () => {
  const actual = jest.requireActual<Record<string, unknown>>("@/utils");
  return {
    ...actual,
    safeFetchNoThrow: (url: string, options?: RequestInit): unknown => mockFetch(url, options),
  };
});

function ok(status = 200, body: unknown = { data: [] }): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Last call to the mocked safeFetchNoThrow, typed. */
function lastCall(): { url: string; options: RequestInit } {
  const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
  return { url, options };
}

function lastHeaders(): Record<string, string> {
  return (lastCall().options.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("verifyProvider — anthropic", () => {
  it("returns ok on 2xx", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    const result = await verifyProvider({
      providerId: "anthropic",
      apiKey: "sk-ant-test",
      type: "anthropic",
    });
    expect(result.ok).toBe(true);
    expect(lastCall().url).toBe("https://api.anthropic.com/v1/models");
    expect(lastCall().options.method).toBe("GET");
    expect(lastHeaders()["x-api-key"]).toBe("sk-ant-test");
    expect(lastHeaders()["anthropic-version"]).toBe("2023-06-01");
  });

  it("honors a custom baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "https://proxy.example.com/anthropic/",
      type: "anthropic",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://proxy.example.com/anthropic/v1/models",
      expect.anything()
    );
  });

  it("fails on 401 with parsed error", async () => {
    mockFetch.mockResolvedValueOnce(ok(401, { error: { message: "invalid x-api-key" } }));
    const result = await verifyProvider({
      providerId: "anthropic",
      apiKey: "bogus",
      type: "anthropic",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid x-api-key");
  });

  it("fails without an API key", async () => {
    const result = await verifyProvider({
      providerId: "anthropic",
      apiKey: "",
      type: "anthropic",
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("verifyProvider — openai-compatible", () => {
  it("hits the canonical OpenAI endpoint when no baseUrl is set", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "openai",
      apiKey: "sk-test",
      type: "openai-compatible",
    });
    expect(lastCall().url).toBe("https://api.openai.com/v1/models");
    expect(lastHeaders().Authorization).toBe("Bearer sk-test");
  });

  it("sends OpenAI-Organization header when extra.openAIOrgId is set", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "openai",
      apiKey: "sk-test",
      extra: { openAIOrgId: "org-123" },
      type: "openai-compatible",
    });
    expect(lastHeaders()["OpenAI-Organization"]).toBe("org-123");
  });

  it("uses a user-supplied baseUrl for custom providers", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "custom:abc",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      type: "openai-compatible",
    });
    expect(lastCall().url).toBe("http://localhost:11434/v1/models");
    expect(lastCall().options.method).toBe("GET");
    // No Authorization header when key is empty (local mode).
    expect(lastHeaders().Authorization).toBeUndefined();
  });

  it("fails when no baseUrl can be resolved", async () => {
    const result = await verifyProvider({
      providerId: "custom:xyz",
      apiKey: "sk-x",
      type: "openai-compatible",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Base URL/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("OpenRouter probes /auth/key (since /models is public)", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "openrouter",
      apiKey: "sk-or-test",
      type: "openai-compatible",
    });
    expect(lastCall().url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(lastHeaders().Authorization).toBe("Bearer sk-or-test");
  });

  it("OpenRouter fails when /auth/key returns 401", async () => {
    mockFetch.mockResolvedValueOnce(ok(401, { error: { message: "No auth credentials found" } }));
    const result = await verifyProvider({
      providerId: "openrouter",
      apiKey: "bogus",
      type: "openai-compatible",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/auth credentials/i);
  });
});

describe("verifyProvider — google", () => {
  it("appends the API key as a query parameter", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "google",
      apiKey: "google-key",
      type: "google",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models?key=google-key",
      expect.objectContaining({ method: "GET" })
    );
  });
});

describe("verifyProvider — azure", () => {
  it("constructs URL from extras when baseUrl is absent", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "azure",
      apiKey: "azure-key",
      extra: {
        azureInstanceName: "myinst",
        azureApiVersion: "2024-05-01-preview",
      },
      type: "azure",
    });
    expect(lastCall().url).toBe(
      "https://myinst.openai.azure.com/openai/deployments?api-version=2024-05-01-preview"
    );
    expect(lastHeaders()["api-key"]).toBe("azure-key");
  });

  it("parses host and api-version from a pasted baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "azure",
      apiKey: "azure-key",
      baseUrl:
        "https://myinst.openai.azure.com/openai/deployments/mydeploy/chat/completions?api-version=2024-08-01",
      type: "azure",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://myinst.openai.azure.com/openai/deployments?api-version=2024-08-01",
      expect.anything()
    );
  });

  it("extras take precedence over a pasted baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "azure",
      apiKey: "azure-key",
      baseUrl: "https://other.openai.azure.com?api-version=2023-12-01",
      extra: {
        azureInstanceName: "primary",
        azureApiVersion: "2024-05-01-preview",
      },
      type: "azure",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://primary.openai.azure.com/openai/deployments?api-version=2024-05-01-preview",
      expect.anything()
    );
  });

  it("fails when neither baseUrl nor extras provide instance + version", async () => {
    const result = await verifyProvider({
      providerId: "azure",
      apiKey: "azure-key",
      type: "azure",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Azure/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("verifyProvider — bedrock", () => {
  it("POSTs to bedrock-runtime with bearer token and default region", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "amazon-bedrock",
      apiKey: "aws-bedrock-key",
      type: "bedrock",
    });
    expect(lastCall().url).toMatch(
      /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\//
    );
    expect(lastCall().options.method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer aws-bedrock-key");
  });

  it("uses extra.bedrockRegion when set", async () => {
    mockFetch.mockResolvedValueOnce(ok(200));
    await verifyProvider({
      providerId: "amazon-bedrock",
      apiKey: "aws-bedrock-key",
      extra: { bedrockRegion: "eu-west-1" },
      type: "bedrock",
    });
    expect(lastCall().url).toMatch(/eu-west-1/);
  });
});

describe("verifyProvider — github-copilot", () => {
  it("always hard-blocks with the sign-in message", async () => {
    const result = await verifyProvider({
      providerId: "github-copilot",
      apiKey: "anything",
      type: "github-copilot",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Sign in to GitHub Copilot/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("verifyProvider — error mapping", () => {
  it("maps 404 to an endpoint-not-found message", async () => {
    mockFetch.mockResolvedValueOnce(ok(404, ""));
    const result = await verifyProvider({
      providerId: "openai",
      apiKey: "sk-x",
      baseUrl: "https://wrong.example.com",
      type: "openai-compatible",
    });
    expect(result.error).toMatch(/Endpoint not found/);
  });

  it("maps 500 to a provider-error message", async () => {
    mockFetch.mockResolvedValueOnce(ok(503, ""));
    const result = await verifyProvider({
      providerId: "anthropic",
      apiKey: "sk-x",
      type: "anthropic",
    });
    expect(result.error).toMatch(/Provider error/);
  });
});
