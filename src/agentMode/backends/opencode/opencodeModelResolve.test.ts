import type { CopilotSettings } from "@/settings/model";
import type { ConfiguredModel, Provider, ProviderOrigin } from "@/modelManagement";
import { mapProviderToOpencodeId, opencodeEnabledWireIds } from "./opencodeModelResolve";

/** Build a minimal `Provider` row for a given origin + type. */
function makeProvider(providerId: string, origin: ProviderOrigin): Provider {
  return {
    providerId,
    providerType: "anthropic",
    displayName: providerId,
    origin,
    addedAt: 0,
  };
}

/** Build a minimal `ConfiguredModel` row. */
function makeModel(configuredModelId: string, providerId: string, wireId: string): ConfiguredModel {
  return {
    configuredModelId,
    providerId,
    info: { id: wireId, displayName: wireId },
    configuredAt: 0,
  };
}

/**
 * Assemble a `CopilotSettings`-shaped object with only the slices
 * `opencodeEnabledWireIds` reads. Cast through `unknown` since the resolver
 * touches just `backends` / `configuredModels` / `providers`.
 */
function makeSettings(args: {
  enabledModels?: string[];
  configuredModels?: ConfiguredModel[];
  providers?: Record<string, Provider>;
}): CopilotSettings {
  return {
    backends:
      args.enabledModels === undefined
        ? {}
        : { opencode: { enabledModels: args.enabledModels, defaultModel: null } },
    configuredModels: args.configuredModels ?? [],
    providers: args.providers ?? {},
  } as unknown as CopilotSettings;
}

describe("mapProviderToOpencodeId", () => {
  it("maps a BYOK provider with a catalog id to that id, non-native", () => {
    const provider = makeProvider("p1", { kind: "byok", catalogProviderId: "anthropic" });
    expect(mapProviderToOpencodeId(provider)).toEqual({ id: "anthropic", native: false });
  });

  it("maps BYOK openrouter to openrouter, non-native", () => {
    const provider = makeProvider("p1", { kind: "byok", catalogProviderId: "openrouter" });
    expect(mapProviderToOpencodeId(provider)).toEqual({ id: "openrouter", native: false });
  });

  it("returns null for a BYOK provider without a catalog id (custom endpoint)", () => {
    const provider = makeProvider("p1", { kind: "byok" });
    expect(mapProviderToOpencodeId(provider)).toBeNull();
  });

  it("maps copilot-plus origin to the reserved copilot-plus id, non-native", () => {
    const provider = makeProvider("p1", { kind: "copilot-plus" });
    expect(mapProviderToOpencodeId(provider)).toEqual({ id: "copilot-plus", native: false });
  });

  it("maps an agent-origin provider to its providerId, native", () => {
    const provider = makeProvider("opencode-provider", { kind: "agent", agentType: "opencode" });
    expect(mapProviderToOpencodeId(provider)).toEqual({
      id: "opencode-provider",
      native: true,
    });
  });
});

describe("opencodeEnabledWireIds", () => {
  it("returns the shared frozen empty set when no models are enabled", () => {
    const first = opencodeEnabledWireIds(makeSettings({ enabledModels: [] }));
    const second = opencodeEnabledWireIds(makeSettings({ enabledModels: [] }));
    expect(first.size).toBe(0);
    // Referential stability: the same frozen constant on every empty call.
    expect(first).toBe(second);
  });

  it("returns the shared frozen empty set when the opencode backend is absent", () => {
    const result = opencodeEnabledWireIds(makeSettings({}));
    expect(result.size).toBe(0);
  });

  it("builds `<provider>/<model>` wire ids for BYOK models", () => {
    const settings = makeSettings({
      enabledModels: ["cm1"],
      providers: { p1: makeProvider("p1", { kind: "byok", catalogProviderId: "anthropic" }) },
      configuredModels: [makeModel("cm1", "p1", "claude-sonnet-4-6")],
    });
    const result = opencodeEnabledWireIds(settings);
    expect([...result]).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("builds `<provider>/<model>` wire ids for copilot-plus models", () => {
    const settings = makeSettings({
      enabledModels: ["cm1"],
      providers: { p1: makeProvider("p1", { kind: "copilot-plus" }) },
      configuredModels: [makeModel("cm1", "p1", "copilot-plus-flash")],
    });
    const result = opencodeEnabledWireIds(settings);
    expect([...result]).toEqual(["copilot-plus/copilot-plus-flash"]);
  });

  it("uses the verbatim info.id for agent-origin models (already full wire form)", () => {
    const settings = makeSettings({
      enabledModels: ["cm1"],
      providers: { p1: makeProvider("p1", { kind: "agent", agentType: "opencode" }) },
      configuredModels: [makeModel("cm1", "p1", "opencode/big-pickle")],
    });
    const result = opencodeEnabledWireIds(settings);
    expect([...result]).toEqual(["opencode/big-pickle"]);
  });

  it("skips models whose provider row is missing", () => {
    const settings = makeSettings({
      enabledModels: ["cm1"],
      providers: {},
      configuredModels: [makeModel("cm1", "p1", "claude-sonnet-4-6")],
    });
    expect(opencodeEnabledWireIds(settings).size).toBe(0);
  });

  it("skips models whose configured-model row is missing", () => {
    const settings = makeSettings({
      enabledModels: ["missing"],
      providers: { p1: makeProvider("p1", { kind: "byok", catalogProviderId: "anthropic" }) },
      configuredModels: [],
    });
    expect(opencodeEnabledWireIds(settings).size).toBe(0);
  });

  it("skips models on unroutable providers (BYOK without catalog id)", () => {
    const settings = makeSettings({
      enabledModels: ["cm1"],
      providers: { p1: makeProvider("p1", { kind: "byok" }) },
      configuredModels: [makeModel("cm1", "p1", "some-azure-model")],
    });
    expect(opencodeEnabledWireIds(settings).size).toBe(0);
  });

  it("mixes BYOK and agent-origin models with the correct wire shapes", () => {
    const settings = makeSettings({
      enabledModels: ["cm-byok", "cm-agent"],
      providers: {
        byok: makeProvider("byok", { kind: "byok", catalogProviderId: "openai" }),
        agent: makeProvider("agent", { kind: "agent", agentType: "opencode" }),
      },
      configuredModels: [
        makeModel("cm-byok", "byok", "gpt-5"),
        makeModel("cm-agent", "agent", "opencode/big-pickle"),
      ],
    });
    const result = opencodeEnabledWireIds(settings);
    expect([...result].sort()).toEqual(["openai/gpt-5", "opencode/big-pickle"].sort());
  });
});
