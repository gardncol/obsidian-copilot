import {
  isAnthropicAdaptiveThinkingModel,
  isAnthropicThinkingModel,
  isOpenAIGPT5,
  isOpenAIOSeries,
} from "@/modelManagement/providers/adapters/adapterUtils";

describe("isOpenAIGPT5", () => {
  it("matches gpt-5 family ids", () => {
    expect(isOpenAIGPT5("gpt-5")).toBe(true);
    expect(isOpenAIGPT5("gpt-5-mini")).toBe(true);
    expect(isOpenAIGPT5("gpt-5-2026-01-01")).toBe(true);
  });

  it("rejects non-gpt-5 ids", () => {
    expect(isOpenAIGPT5("gpt-4o")).toBe(false);
    expect(isOpenAIGPT5("claude-sonnet-4-5")).toBe(false);
    expect(isOpenAIGPT5("o3-mini")).toBe(false);
  });
});

describe("isOpenAIOSeries", () => {
  it("matches o-series ids (o1/o3/o4)", () => {
    expect(isOpenAIOSeries("o1")).toBe(true);
    expect(isOpenAIOSeries("o1-mini")).toBe(true);
    expect(isOpenAIOSeries("o3-mini")).toBe(true);
    expect(isOpenAIOSeries("o4-mini")).toBe(true);
  });

  it("rejects non-o-series ids", () => {
    expect(isOpenAIOSeries("gpt-5")).toBe(false);
    expect(isOpenAIOSeries("gpt-4")).toBe(false);
    expect(isOpenAIOSeries("openai/o3-mini")).toBe(false);
  });
});

describe("isAnthropicThinkingModel", () => {
  it("flags 3-7-sonnet, sonnet-4, and opus-4 families", () => {
    expect(isAnthropicThinkingModel("claude-3-7-sonnet-20250219")).toBe(true);
    expect(isAnthropicThinkingModel("claude-sonnet-4-5")).toBe(true);
    expect(isAnthropicThinkingModel("claude-opus-4-7")).toBe(true);
  });

  it("rejects older Claude families", () => {
    expect(isAnthropicThinkingModel("claude-3-5-sonnet")).toBe(false);
    expect(isAnthropicThinkingModel("claude-3-opus")).toBe(false);
    expect(isAnthropicThinkingModel("claude-2.1")).toBe(false);
  });
});

describe("isAnthropicAdaptiveThinkingModel", () => {
  it("flags claude-opus-4-7 as adaptive thinking", () => {
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-7")).toBe(true);
  });

  it("flags claude-opus-4-8 and higher as adaptive thinking", () => {
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-8")).toBe(true);
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-12")).toBe(true);
  });

  it("keeps claude-opus-4-6 and earlier on legacy thinking", () => {
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-6")).toBe(false);
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-0")).toBe(false);
  });

  it("does not affect other thinking-enabled families", () => {
    expect(isAnthropicAdaptiveThinkingModel("claude-sonnet-4-5")).toBe(false);
    expect(isAnthropicAdaptiveThinkingModel("claude-3-7-sonnet-20250219")).toBe(false);
  });

  it("does not match unversioned claude-opus-4 prefix", () => {
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4")).toBe(false);
  });

  it("does not treat dated snapshot IDs as adaptive thinking minors", () => {
    // claude-opus-4-20250514 is the dated snapshot of Opus 4.0, not Opus 4.20250514.
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-20250514")).toBe(false);
    // claude-opus-4-1-20250805 is dated 4.1.
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-1-20250805")).toBe(false);
    // Dated 4.7 still matches because the minor is delimited by "-".
    expect(isAnthropicAdaptiveThinkingModel("claude-opus-4-7-20260115")).toBe(true);
  });
});
