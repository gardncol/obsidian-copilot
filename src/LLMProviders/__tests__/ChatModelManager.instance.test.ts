/**
 * Regression test for Task 7 of MODEL_MANAGEMENT_REVIEW.md.
 *
 * `ChatModelManager` previously held the active chat model in a process-wide
 * static field, which meant two scopes (e.g. project chat + Quick Chat agent)
 * picking different models would clobber each other. The manager is now
 * per-instance — these tests pin that contract.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { CustomModel } from "@/aiParams";

// Settings used by the constructor's buildModelMap() — return a minimal
// fixture so the manager constructs cleanly.
jest.mock("@/settings/model", () => ({
  getSettings: () => ({
    activeModels: [],
    openAIApiKey: "",
    googleApiKey: "",
    azureOpenAIApiKey: "",
    anthropicApiKey: "",
    cohereApiKey: "",
    openRouterAiApiKey: "",
    groqApiKey: "",
    xaiApiKey: "",
    plusLicenseKey: "",
    mistralApiKey: "",
    deepseekApiKey: "",
    amazonBedrockApiKey: "",
    siliconflowApiKey: "",
    githubCopilotToken: "",
    githubCopilotAccessToken: "",
    temperature: 0.7,
    maxTokens: 1000,
    openAIOrgId: "",
  }),
  getModelKeyFromModel: (m: { name: string; provider: string }) => `${m.name}|${m.provider}`,
  subscribeToSettingsChange: jest.fn().mockReturnValue(() => {}),
}));

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

// The factory pulls in every provider adapter (incl. @langchain/anthropic),
// which transitively requires native SDKs that don't resolve under jsdom.
// We stub the factory + Azure adapter helper since this test only exercises
// instance state, not the model build path.
jest.mock("@/modelManagement/chatModel/ChatModelFactory", () => ({
  ChatModelFactory: { create: jest.fn() },
}));
jest.mock("@/modelManagement/providers/adapters/AzureAdapter", () => ({
  normalizeAzureUrl: (u: string) => u,
}));
jest.mock("@/modelManagement", () => ({
  ModelCatalogService: { getInstance: () => ({}) },
}));

import ChatModelManager from "@/LLMProviders/ChatModelManager";

/** Build a stub BaseChatModel that the manager can store + return. */
function makeFakeChatModel(label: string): BaseChatModel {
  return {
    __label: label,
    getNumTokens: async (s: string) => s.length,
  } as unknown as BaseChatModel;
}

/** Build a minimal CustomModel; we'll stub createModelInstance so its
 *  contents don't actually drive a LangChain build. */
function makeCustomModel(name: string, provider = "openai"): CustomModel {
  return {
    name,
    provider,
    enabled: true,
  };
}

describe("ChatModelManager — per-instance isolation", () => {
  it("two instances hold independent active models simultaneously", async () => {
    const managerA = new ChatModelManager();
    const managerB = new ChatModelManager();

    const modelX = makeFakeChatModel("model-X");
    const modelY = makeFakeChatModel("model-Y");

    // Bypass the factory dispatch — we only care about instance state here.
    jest.spyOn(managerA, "createModelInstance").mockResolvedValue(modelX);
    jest.spyOn(managerB, "createModelInstance").mockResolvedValue(modelY);

    await managerA.setChatModel(makeCustomModel("gpt-4"));
    await managerB.setChatModel(makeCustomModel("claude-sonnet", "anthropic"));

    // Both instances expose their own model — neither shadows the other.
    expect(managerA.getChatModel()).toBe(modelX);
    expect(managerB.getChatModel()).toBe(modelY);
    expect(managerA.getChatModel()).not.toBe(managerB.getChatModel());
  });

  it("setChatModel on one instance does not mutate another instance", async () => {
    const managerA = new ChatModelManager();
    const managerB = new ChatModelManager();

    const modelX = makeFakeChatModel("model-X");
    const modelY = makeFakeChatModel("model-Y");

    jest.spyOn(managerA, "createModelInstance").mockResolvedValue(modelX);
    jest.spyOn(managerB, "createModelInstance").mockResolvedValue(modelY);

    // A picks X first.
    await managerA.setChatModel(makeCustomModel("gpt-4"));
    expect(managerA.getChatModel()).toBe(modelX);

    // B picks Y after — A must still report X (no shared static slot).
    await managerB.setChatModel(makeCustomModel("claude-sonnet", "anthropic"));
    expect(managerA.getChatModel()).toBe(modelX);
    expect(managerB.getChatModel()).toBe(modelY);

    // A swaps to a fresh model — B remains untouched.
    const modelZ = makeFakeChatModel("model-Z");
    (managerA.createModelInstance as jest.Mock).mockResolvedValue(modelZ);
    await managerA.setChatModel(makeCustomModel("gpt-4o"));
    expect(managerA.getChatModel()).toBe(modelZ);
    expect(managerB.getChatModel()).toBe(modelY);
  });

  it("static getInstance() returns a fresh instance each call (no shared singleton)", () => {
    const a = ChatModelManager.getInstance();
    const b = ChatModelManager.getInstance();
    expect(a).not.toBe(b);
  });
});
