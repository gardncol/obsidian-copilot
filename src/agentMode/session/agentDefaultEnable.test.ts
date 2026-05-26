import { computeDefaultEnabledIds, type EnrolledModelRef } from "./agentDefaultEnable";

function refs(...pairs: Array<[string, string]>): EnrolledModelRef[] {
  return pairs.map(([configuredModelId, wireModelId]) => ({ configuredModelId, wireModelId }));
}

describe("computeDefaultEnabledIds", () => {
  it("enables the model matching the agent's current wire id", () => {
    const enrolled = refs(["cm-1", "gpt-5"], ["cm-2", "gpt-5.5"]);
    expect(computeDefaultEnabledIds(enrolled, "gpt-5.5")).toEqual(["cm-2"]);
  });

  it("falls back to the first enrolled model when the current id isn't enrolled", () => {
    const enrolled = refs(["cm-1", "gpt-5"], ["cm-2", "gpt-5.5"]);
    // e.g. the current model was suppressed as a Copilot-managed opencode model.
    expect(computeDefaultEnabledIds(enrolled, "anthropic/claude-sonnet-4-5")).toEqual(["cm-1"]);
  });

  it("falls back to the first enrolled model when there is no current id", () => {
    const enrolled = refs(["cm-1", "gpt-5"], ["cm-2", "gpt-5.5"]);
    expect(computeDefaultEnabledIds(enrolled, undefined)).toEqual(["cm-1"]);
  });

  it("returns an empty list when nothing is enrolled", () => {
    expect(computeDefaultEnabledIds([], "gpt-5")).toEqual([]);
  });
});
