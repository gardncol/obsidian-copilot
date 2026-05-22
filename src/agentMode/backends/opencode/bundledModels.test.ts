/**
 * `bundledModels` tests.
 *
 * Verifies that `listBundledModels` correctly:
 *   - Returns `null` when the session manager / cached state is missing
 *     (so the panel can render the "OpenCode not installed" empty-state).
 *   - Surfaces OpenCode-native model rows (non-BYOK provider prefixes).
 *   - Filters out rows whose provider prefix maps onto a BYOK / Copilot Plus
 *     provider (those belong to the other sections).
 */
import type { BackendState } from "@/agentMode/session/types";
import {
  classifyOpencodeModels,
  filterBundledEntries,
  listBundledModels,
  type ModelRegistryLike,
  type ProviderRegistryLike,
} from "./bundledModels";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

/** Fake provider registry. Any id passed in via `byokIds` is treated as a
 * registered BYOK provider; everything else returns `undefined`. */
function makeRegistry(byokIds: string[] = []): ProviderRegistryLike {
  const set = new Set(byokIds);
  return { get: (id: string) => (set.has(id) ? { id } : undefined) };
}

/** Fake model registry. `picks` is a list of `<providerId>|<modelId>` keys
 * the user has picked; lookups outside that set return `undefined`. */
function makeModelRegistry(picks: string[] = []): ModelRegistryLike {
  const set = new Set(picks);
  return {
    get: (providerId: string, modelId: string) =>
      set.has(`${providerId}|${modelId}`) ? { providerId, modelId } : undefined,
  };
}

const allModelsRegistered: ModelRegistryLike = {
  get: (providerId: string, modelId: string) => ({ providerId, modelId }),
};

const noModelsRegistered: ModelRegistryLike = {
  get: () => undefined,
};

/** Build a minimal `BackendState` carrying the given availableModels. */
function makeState(
  availableModels: Array<{ baseModelId: string; name: string; provider?: string | null }>
): BackendState {
  return {
    model: {
      current: { baseModelId: availableModels[0]?.baseModelId ?? "", effort: null },
      availableModels: availableModels.map((m) => ({
        baseModelId: m.baseModelId,
        name: m.name,
        provider: m.provider ?? null,
        effortOptions: [],
      })),
    },
    mode: null,
  };
}

describe("classifyOpencodeModels", () => {
  const entries = [
    { baseModelId: "bigpickle/big-pickle", name: "Big Pickle", provider: null, effortOptions: [] },
    {
      baseModelId: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      effortOptions: [],
    },
    { baseModelId: "openai/gpt-5", name: "GPT-5", provider: "openai", effortOptions: [] },
    {
      baseModelId: "copilot-plus/copilot-plus-flash",
      name: "Copilot Plus Flash",
      provider: "copilot-plus",
      effortOptions: [],
    },
    {
      baseModelId: "custom:abc-uuid/llama-3.3",
      name: "Llama 3.3",
      provider: null,
      effortOptions: [],
    },
  ];

  it("routes models whose (providerId, modelId) is in ModelRegistry into the byok bucket", () => {
    const result = classifyOpencodeModels(
      entries,
      makeRegistry(["anthropic", "openai", "custom:abc-uuid"]),
      allModelsRegistered
    );
    expect(result.byok.map((m) => m.baseModelId)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "custom:abc-uuid/llama-3.3",
    ]);
  });

  it("routes copilot-plus models into the plus bucket regardless of registry", () => {
    const result = classifyOpencodeModels(entries, makeRegistry([]), noModelsRegistered);
    expect(result.plus.map((m) => m.baseModelId)).toEqual(["copilot-plus/copilot-plus-flash"]);
  });

  it("treats unregistered leading segments as bundled", () => {
    const result = classifyOpencodeModels(
      entries,
      makeRegistry(["anthropic"]),
      allModelsRegistered
    );
    // openai not registered → falls into bundled; custom:abc-uuid not registered → also bundled.
    expect(result.bundled.map((m) => m.baseModelId)).toEqual([
      "bigpickle/big-pickle",
      "openai/gpt-5",
      "custom:abc-uuid/llama-3.3",
    ]);
  });

  it("drops models whose provider is registered but whose modelId is NOT in ModelRegistry", () => {
    // Mimics the real scenario: user registered OpenRouter and picked 2
    // specific models. OpenCode reports its full ~50-row bundled snapshot
    // for openrouter. Only the 2 picked rows should appear; the rest
    // should be dropped (not appear in byok, bundled, or plus).
    const orEntries = [
      {
        baseModelId: "openrouter/moonshotai/kimi-k2-thinking",
        name: "Kimi K2",
        provider: "openrouter",
        effortOptions: [],
      },
      {
        baseModelId: "openrouter/openai/gpt-5.5",
        name: "GPT-5.5",
        provider: "openrouter",
        effortOptions: [],
      },
      {
        baseModelId: "openrouter/google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "openrouter",
        effortOptions: [],
      },
      {
        baseModelId: "openrouter/meta-llama/llama-3.3-70b",
        name: "Llama 3.3 70B",
        provider: "openrouter",
        effortOptions: [],
      },
    ];
    const result = classifyOpencodeModels(
      orEntries,
      makeRegistry(["openrouter"]),
      makeModelRegistry(["openrouter|moonshotai/kimi-k2-thinking", "openrouter|openai/gpt-5.5"])
    );
    expect(result.byok.map((m) => m.baseModelId)).toEqual([
      "openrouter/moonshotai/kimi-k2-thinking",
      "openrouter/openai/gpt-5.5",
    ]);
    expect(result.bundled).toEqual([]);
    expect(result.plus).toEqual([]);
  });
});

describe("filterBundledEntries", () => {
  const registry = makeRegistry(["anthropic", "openai", "google", "openrouter"]);

  it("keeps OpenCode-native rows that have no BYOK provider prefix", () => {
    const result = filterBundledEntries(
      [
        {
          baseModelId: "bigpickle/big-pickle",
          name: "Big Pickle",
          provider: null,
          effortOptions: [],
        },
        {
          baseModelId: "bigpickle/turbo",
          name: "Big Pickle Turbo",
          provider: null,
          effortOptions: [],
        },
      ],
      registry,
      noModelsRegistered
    );
    expect(result).toEqual([
      { id: "bigpickle/big-pickle", displayName: "Big Pickle", provider: "bigpickle" },
      { id: "bigpickle/turbo", displayName: "Big Pickle Turbo", provider: "bigpickle" },
    ]);
  });

  it("filters out rows whose provider prefix is a BYOK / Plus provider", () => {
    const result = filterBundledEntries(
      [
        {
          baseModelId: "anthropic/claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
          effortOptions: [],
        },
        {
          baseModelId: "openai/gpt-5",
          name: "GPT-5",
          provider: "openai",
          effortOptions: [],
        },
        {
          baseModelId: "copilot-plus/copilot-plus-flash",
          name: "Copilot Plus Flash",
          provider: "copilot-plus",
          effortOptions: [],
        },
      ],
      registry,
      allModelsRegistered
    );
    expect(result).toEqual([]);
  });

  it("returns an empty array when there are no available models", () => {
    expect(filterBundledEntries([], registry, noModelsRegistered)).toEqual([]);
  });

  it("drops rows without a provider segment (malformed ids)", () => {
    const result = filterBundledEntries(
      [{ baseModelId: "big-pickle", name: "Big Pickle", provider: null, effortOptions: [] }],
      registry,
      noModelsRegistered
    );
    // No slash → leadingSegment returns null → row is treated as "no provider
    // prefix" → it _is_ kept (we only filter when the prefix matches a BYOK
    // provider). This documents the intentional behavior so contributors don't
    // accidentally over-tighten the filter.
    expect(result).toEqual([{ id: "big-pickle", displayName: "Big Pickle", provider: undefined }]);
  });
});

describe("listBundledModels", () => {
  const registry = makeRegistry(["anthropic"]);

  it("returns null when the session manager is missing", async () => {
    const result = await listBundledModels(null, registry, noModelsRegistered);
    expect(result).toBeNull();
  });

  it("returns null when the cached state has no model slice", async () => {
    const sessionManager = {
      getCachedBackendState: () => ({ model: null, mode: null }) as BackendState,
    };
    const result = await listBundledModels(sessionManager as never, registry, noModelsRegistered);
    expect(result).toBeNull();
  });

  it("returns the filtered bundled row list when the cache is populated", async () => {
    const sessionManager = {
      getCachedBackendState: () =>
        makeState([
          { baseModelId: "bigpickle/big-pickle", name: "Big Pickle" },
          { baseModelId: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        ]),
    };
    const result = await listBundledModels(sessionManager as never, registry, allModelsRegistered);
    expect(result).toEqual([
      { id: "bigpickle/big-pickle", displayName: "Big Pickle", provider: "bigpickle" },
    ]);
  });
});
