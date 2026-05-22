import {
  buildCommitSelection,
  buildEffortSibling,
  buildModelOnChange,
  buildPickerEntries,
  resolveActiveDisplayState,
  resolveEffortForOptions,
} from "./agentModelPickerHelpers";
import type { EffortPreference } from "@/agentMode/session/AgentSessionManager";
import type {
  BackendDescriptor,
  BackendState,
  ModelEntry,
  ModelState,
} from "@/agentMode/session/types";
import type { ModelActiveContext } from "./agentModelPickerHelpers";
import type { AgentSessionManager } from "@/agentMode/session/AgentSessionManager";
import type { AgentSession } from "@/agentMode/session/AgentSession";
import type { AgentChatUIState } from "@/agentMode/session/AgentChatUIState";
import type { CopilotSettings } from "@/settings/model";

jest.mock("obsidian", () => ({
  Notice: jest.fn(),
  Modal: class {},
  App: class {},
}));

// Stub out the registry so the test doesn't pull in real backend descriptors
// (which would drag in install modals and other unrelated UI).
jest.mock("@/agentMode/backends/registry", () => {
  const stub = (id: string) => ({
    id,
    displayName: id,
    wire: {
      encode: () => "",
      decode: () => ({ selection: { baseModelId: "", effort: null }, provider: null }),
    },
  });
  return {
    backendRegistry: {
      codex: stub("codex"),
      claude: stub("claude"),
      opencode: stub("opencode"),
    },
    listBackendDescriptors: () => [stub("codex"), stub("claude"), stub("opencode")],
    getActiveBackendDescriptor: () => stub("opencode"),
  };
});

function makeState(modelId: string): BackendState {
  const entry = {
    baseModelId: modelId,
    name: modelId,
    provider: "anthropic",
    effortOptions: [],
  };
  return {
    model: { current: { baseModelId: modelId, effort: null }, availableModels: [entry] },
    mode: null,
  };
}

describe("resolveActiveDisplayState", () => {
  it("returns the active session's state when present", () => {
    const sessionState = makeState("session-model");
    const cacheState = makeState("cache-model");
    const got = resolveActiveDisplayState(sessionState, "codex", () => cacheState);
    expect(got).toBe(sessionState);
  });

  it("isolates sibling tabs on the same backend: cache writes for backend X don't leak when the active session of X has its own state", () => {
    const tab2State = makeState("model-A");
    const tab1WroteThisToCache = makeState("model-B");
    const got = resolveActiveDisplayState(tab2State, "codex", () => tab1WroteThisToCache);
    expect(got?.model?.current.baseModelId).toBe("model-A");
  });

  it("falls back to the cache when the active session reports no state yet", () => {
    const cacheState = makeState("cache-model");
    const got = resolveActiveDisplayState(null, "codex", () => cacheState);
    expect(got).toBe(cacheState);
  });

  it("returns null when there is no active backend at all", () => {
    const got = resolveActiveDisplayState(null, null, () => makeState("ignored"));
    expect(got).toBeNull();
  });

  it("returns null when both session and cache are empty", () => {
    const got = resolveActiveDisplayState(null, "codex", () => null);
    expect(got).toBeNull();
  });
});

// ---- helpers for builder tests ----------------------------------------

function makeDescriptor(id: "codex" | "claude" | "opencode"): BackendDescriptor {
  return {
    id,
    displayName: id,
    wire: {
      encode: () => "",
      decode: () => ({ selection: { baseModelId: "", effort: null }, provider: null }),
    },
  } as unknown as BackendDescriptor;
}

function makeModelEntry(baseModelId: string, name?: string): ModelEntry {
  return {
    baseModelId,
    name: name ?? baseModelId,
    provider: null,
    effortOptions: [],
  };
}

function makeModelState(currentBaseId: string, available: ModelEntry[]): ModelState {
  return {
    current: { baseModelId: currentBaseId, effort: null },
    availableModels: available,
  };
}

function makeUIState(opts: {
  canSwitchModel?: boolean | null;
  canSwitchEffort?: boolean | null;
  canSwitchMode?: boolean | null;
}): AgentChatUIState {
  return {
    canSwitchModel: () => opts.canSwitchModel ?? null,
    canSwitchEffort: () => opts.canSwitchEffort ?? null,
    canSwitchMode: () => opts.canSwitchMode ?? null,
  } as unknown as AgentChatUIState;
}

function makeManager(opts: {
  cachedStateById?: Record<string, BackendState | null>;
  lastSelectionById?: Record<string, { baseModelId: string; effort: string | null } | null>;
  userEffortPreference?: EffortPreference | null;
  setDefaultBackend?: jest.Mock;
  applySelection?: jest.Mock;
  rememberLastSelection?: jest.Mock;
  createSession?: jest.Mock;
  closeSession?: jest.Mock;
  setUserEffortPreference?: jest.Mock;
}): AgentSessionManager {
  return {
    getCachedBackendState: (id: string) => opts.cachedStateById?.[id] ?? null,
    getLastSelection: (id: string) => opts.lastSelectionById?.[id] ?? null,
    getUserEffortPreference: () => opts.userEffortPreference ?? null,
    setUserEffortPreference: opts.setUserEffortPreference ?? jest.fn(),
    setDefaultBackend: opts.setDefaultBackend ?? jest.fn(),
    applySelection: opts.applySelection ?? jest.fn().mockResolvedValue(undefined),
    rememberLastSelection: opts.rememberLastSelection ?? jest.fn(),
    createSession: opts.createSession ?? jest.fn().mockResolvedValue(undefined),
    closeSession: opts.closeSession ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as AgentSessionManager;
}

const emptySettings = {} as CopilotSettings;

// ---- buildPickerEntries ----

describe("buildPickerEntries", () => {
  it("hides non-active backend sections once the active session has history", () => {
    const codex = makeDescriptor("codex");
    const claude = makeDescriptor("claude");
    const codexEntry = makeModelEntry("gpt-5");
    const claudeEntry = makeModelEntry("opus");
    const manager = makeManager({
      cachedStateById: {
        codex: { model: makeModelState("gpt-5", [codexEntry]), mode: null },
        claude: { model: makeModelState("opus", [claudeEntry]), mode: null },
      },
    });
    const ctx: ModelActiveContext = {
      activeSession: { backendId: "codex" } as unknown as AgentSession,
      activeChatUIState: null,
      activeBackendId: "codex",
      activeDescriptor: codex,
      activeSessionHasHistory: true,
      activeModelState: makeModelState("gpt-5", [codexEntry]),
      activeCurrentEntry: codexEntry,
    };
    const { entries } = buildPickerEntries(manager, [codex, claude], ctx, emptySettings);
    const ids = entries.map((e) => e._backendId);
    expect(ids).toEqual(["codex"]);
  });

  it("synthesizes a stranded active model in front when curation removed it", () => {
    const codex = makeDescriptor("codex");
    const stranded = makeModelEntry("ghost-model", "Ghost");
    const visible = makeModelEntry("real-model");
    // Only the "visible" model is in the cached catalog — the active "ghost"
    // is not, so synth-fallback should fire.
    const manager = makeManager({
      cachedStateById: {
        codex: { model: makeModelState("real-model", [visible]), mode: null },
      },
    });
    const ctx: ModelActiveContext = {
      activeSession: { backendId: "codex" } as unknown as AgentSession,
      activeChatUIState: null,
      activeBackendId: "codex",
      activeDescriptor: codex,
      activeSessionHasHistory: false,
      activeModelState: makeModelState("ghost-model", [stranded]),
      activeCurrentEntry: stranded,
    };
    const { entries, valueKey } = buildPickerEntries(manager, [codex], ctx, emptySettings);
    expect(entries[0].name).toBe("ghost-model");
    expect(entries[0]._backendId).toBe("codex");
    expect(valueKey).toBe("codex:ghost-model|agent");
  });

  it("does not add a synth entry when the active model is already in the catalog", () => {
    const codex = makeDescriptor("codex");
    const entry = makeModelEntry("gpt-5");
    const manager = makeManager({
      cachedStateById: {
        codex: { model: makeModelState("gpt-5", [entry]), mode: null },
      },
    });
    const ctx: ModelActiveContext = {
      activeSession: { backendId: "codex" } as unknown as AgentSession,
      activeChatUIState: null,
      activeBackendId: "codex",
      activeDescriptor: codex,
      activeSessionHasHistory: false,
      activeModelState: makeModelState("gpt-5", [entry]),
      activeCurrentEntry: entry,
    };
    const { entries } = buildPickerEntries(manager, [codex], ctx, emptySettings);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("gpt-5");
  });
});

// ---- buildEffortSibling ----

describe("buildEffortSibling", () => {
  function ctxWith(opts: {
    effortOptions: { value: string | null; label: string }[];
    canSwitchEffort?: boolean | null;
  }): ModelActiveContext {
    const entry: ModelEntry = {
      baseModelId: "m",
      name: "m",
      provider: null,
      effortOptions: opts.effortOptions,
    };
    return {
      activeSession: { backendId: "codex" } as unknown as AgentSession,
      activeChatUIState: makeUIState({ canSwitchEffort: opts.canSwitchEffort }),
      activeBackendId: "codex",
      activeDescriptor: makeDescriptor("codex"),
      activeSessionHasHistory: false,
      activeModelState: makeModelState("m", [entry]),
      activeCurrentEntry: entry,
    };
  }

  it("returns undefined when the current entry has no effort options", () => {
    const got = buildEffortSibling(makeManager({}), ctxWith({ effortOptions: [] }));
    expect(got).toBeUndefined();
  });

  it("disabled mirrors canSwitchEffort() === false", () => {
    const got = buildEffortSibling(
      makeManager({}),
      ctxWith({
        effortOptions: [{ value: "low", label: "Low" }],
        canSwitchEffort: false,
      })
    );
    expect(got?.disabled).toBe(true);
  });

  it("disabled is false when canSwitchEffort returns true or null", () => {
    expect(
      buildEffortSibling(
        makeManager({}),
        ctxWith({ effortOptions: [{ value: "low", label: "Low" }], canSwitchEffort: true })
      )?.disabled
    ).toBe(false);
    expect(
      buildEffortSibling(
        makeManager({}),
        ctxWith({ effortOptions: [{ value: "low", label: "Low" }], canSwitchEffort: null })
      )?.disabled
    ).toBe(false);
  });
});

// ---- buildModelOnChange ----

describe("buildModelOnChange", () => {
  function pickerEntry(backendId: string, baseModelId: string) {
    return {
      name: baseModelId,
      provider: "agent",
      enabled: true,
      isBuiltIn: false,
      displayName: baseModelId,
      _group: backendId,
      _backendId: backendId,
    };
  }

  function ctxFor(activeBackendId: string | null): ModelActiveContext {
    const session = activeBackendId
      ? ({ backendId: activeBackendId, internalId: "tab-1" } as unknown as AgentSession)
      : null;
    return {
      activeSession: session,
      activeChatUIState: makeUIState({ canSwitchModel: true }),
      activeBackendId,
      activeDescriptor: activeBackendId ? makeDescriptor("codex") : undefined,
      activeSessionHasHistory: false,
      activeModelState: null,
      activeCurrentEntry: undefined,
    };
  }

  it("same-backend pick calls setDefaultBackend then applySelection with the chosen base", () => {
    const setDefaultBackend = jest.fn();
    const applySelection = jest.fn().mockResolvedValue(undefined);
    const manager = makeManager({ setDefaultBackend, applySelection });
    const entries = [pickerEntry("codex", "gpt-5")];
    const onChange = buildModelOnChange(manager, ctxFor("codex"), entries);
    onChange("codex:gpt-5|agent");
    expect(setDefaultBackend).toHaveBeenCalledWith("codex");
    // No effort preference and no effort options on the target → effort is
    // resolved to null and passed explicitly so the descriptor's
    // applySelection sees the canonical "no effort" pick.
    expect(applySelection).toHaveBeenCalledWith({ baseModelId: "gpt-5", effort: null });
  });

  it("same-backend pick with canSwitchModel === false does not call applySelection", () => {
    const applySelection = jest.fn().mockResolvedValue(undefined);
    const ctx = ctxFor("codex");
    ctx.activeChatUIState = makeUIState({ canSwitchModel: false });
    const manager = makeManager({ applySelection });
    const entries = [pickerEntry("codex", "gpt-5")];
    const onChange = buildModelOnChange(manager, ctx, entries);
    onChange("codex:gpt-5|agent");
    expect(applySelection).not.toHaveBeenCalled();
  });

  it("cross-backend pick remembers the new (model, effort) on the target backend before creating the session", async () => {
    const rememberLastSelection = jest.fn();
    const createSession = jest.fn().mockResolvedValue(undefined);
    const setDefaultBackend = jest.fn();
    const closeSession = jest.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];
    rememberLastSelection.mockImplementation(() => {
      callOrder.push("remember");
    });
    createSession.mockImplementation(async () => {
      callOrder.push("create");
    });
    const manager = makeManager({
      rememberLastSelection,
      createSession,
      setDefaultBackend,
      closeSession,
      lastSelectionById: { claude: { baseModelId: "old", effort: "low" } },
    });
    const entries = [pickerEntry("claude", "opus")];
    const onChange = buildModelOnChange(manager, ctxFor("codex"), entries);
    onChange("claude:opus|agent");
    // Allow the IIFE to run.
    await new Promise((r) => window.setTimeout(r, 0));
    expect(rememberLastSelection).toHaveBeenCalledWith("claude", {
      baseModelId: "opus",
      effort: "low",
    });
    expect(createSession).toHaveBeenCalledWith("claude");
    expect(callOrder).toEqual(["remember", "create"]);
    expect(setDefaultBackend).toHaveBeenCalledWith("claude");
    expect(closeSession).toHaveBeenCalledWith("tab-1");
  });

  it("ignores entries with no _backendId or unresolvable baseModelId", () => {
    const setDefaultBackend = jest.fn();
    const applySelection = jest.fn();
    const manager = makeManager({ setDefaultBackend, applySelection });
    const entries = [
      { name: "no-backend", provider: "agent", enabled: true, isBuiltIn: false, displayName: "x" },
    ];
    const onChange = buildModelOnChange(manager, ctxFor("codex"), entries);
    // Bare `name|provider` form — entry has no `_backendId`.
    onChange("no-backend|agent");
    expect(setDefaultBackend).not.toHaveBeenCalled();
    expect(applySelection).not.toHaveBeenCalled();
  });

  it("same-backend pick re-resolves the effort intent against the target model's options (label match)", () => {
    const applySelection = jest.fn().mockResolvedValue(undefined);
    const opus = makeModelEntry("opus");
    opus.effortOptions = [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ];
    const sonnet = makeModelEntry("sonnet");
    sonnet.effortOptions = [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
    ];
    const ctx = ctxFor("claude");
    ctx.activeModelState = makeModelState("opus", [opus, sonnet]);
    const manager = makeManager({
      applySelection,
      userEffortPreference: { value: "high", index: 2 },
    });
    const entries = [pickerEntry("claude", "sonnet")];
    const onChange = buildModelOnChange(manager, ctx, entries);
    onChange("claude:sonnet|agent");
    // Sonnet has no "high" — fall back to index 2 clamped to last
    // available, i.e. "medium".
    expect(applySelection).toHaveBeenCalledWith({ baseModelId: "sonnet", effort: "medium" });
  });

  it("same-backend pick to a no-effort model passes effort: null without clobbering the preference", () => {
    const applySelection = jest.fn().mockResolvedValue(undefined);
    const setUserEffortPreference = jest.fn();
    const opus = makeModelEntry("opus");
    opus.effortOptions = [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ];
    const haiku = makeModelEntry("haiku");
    haiku.effortOptions = [];
    const ctx = ctxFor("claude");
    ctx.activeModelState = makeModelState("opus", [opus, haiku]);
    const manager = makeManager({
      applySelection,
      setUserEffortPreference,
      userEffortPreference: { value: "high", index: 2 },
    });
    const entries = [pickerEntry("claude", "haiku")];
    const onChange = buildModelOnChange(manager, ctx, entries);
    onChange("claude:haiku|agent");
    expect(applySelection).toHaveBeenCalledWith({ baseModelId: "haiku", effort: null });
    // Crucial: a model-only swap must not update the preference, so that
    // swapping back to a model with effort still restores "high".
    expect(setUserEffortPreference).not.toHaveBeenCalled();
  });
});

// ---- buildEffortSibling.onChange ----

describe("buildEffortSibling.onChange", () => {
  it("records the picked effort + its index in the active model's options", () => {
    const applySelection = jest.fn().mockResolvedValue(undefined);
    const setUserEffortPreference = jest.fn();
    const opus: ModelEntry = {
      baseModelId: "opus",
      name: "opus",
      provider: null,
      effortOptions: [
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
      ],
    };
    const ctx: ModelActiveContext = {
      activeSession: { backendId: "claude" } as unknown as AgentSession,
      activeChatUIState: makeUIState({ canSwitchEffort: true }),
      activeBackendId: "claude",
      activeDescriptor: makeDescriptor("claude"),
      activeSessionHasHistory: false,
      activeModelState: makeModelState("opus", [opus]),
      activeCurrentEntry: opus,
    };
    const manager = makeManager({ applySelection, setUserEffortPreference });
    const sibling = buildEffortSibling(manager, ctx);
    sibling?.onChange("high");
    expect(setUserEffortPreference).toHaveBeenCalledWith("high", 2);
    expect(applySelection).toHaveBeenCalledWith({ effort: "high" }, { expectBackendId: "claude" });
  });
});

// ---- buildCommitSelection ----

describe("buildCommitSelection", () => {
  function pickerEntry(backendId: string, baseModelId: string) {
    return {
      name: baseModelId,
      provider: "agent",
      enabled: true,
      isBuiltIn: false,
      displayName: baseModelId,
      _group: backendId,
      _backendId: backendId,
    };
  }

  function ctxFor(activeBackendId: string | null): ModelActiveContext {
    const session = activeBackendId
      ? ({ backendId: activeBackendId, internalId: "tab-1" } as unknown as AgentSession)
      : null;
    return {
      activeSession: session,
      activeChatUIState: makeUIState({ canSwitchModel: true }),
      activeBackendId,
      activeDescriptor: activeBackendId ? makeDescriptor("claude") : undefined,
      activeSessionHasHistory: false,
      activeModelState: null,
      activeCurrentEntry: undefined,
    };
  }

  it("records the committed effort + its index before applying the same-backend pick", () => {
    const applySelection = jest.fn().mockResolvedValue(undefined);
    const setUserEffortPreference = jest.fn();
    const opus = makeModelEntry("opus");
    opus.effortOptions = [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ];
    const ctx = ctxFor("claude");
    ctx.activeModelState = makeModelState("opus", [opus]);
    const manager = makeManager({ applySelection, setUserEffortPreference });
    const entries = [pickerEntry("claude", "opus")];
    const commit = buildCommitSelection(manager, ctx, entries, () => {});
    commit("claude:opus|agent", "medium");
    expect(setUserEffortPreference).toHaveBeenCalledWith("medium", 1);
    expect(applySelection).toHaveBeenCalledWith({ baseModelId: "opus", effort: "medium" });
  });
});

// ---- resolveEffortForOptions ----

describe("resolveEffortForOptions", () => {
  const options = [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
  ];

  it("returns null when the target has no effort options", () => {
    expect(resolveEffortForOptions({ value: "high", index: 2 }, [])).toBeNull();
  });

  it("returns the first option when there is no preference", () => {
    expect(resolveEffortForOptions(null, options)).toBe("low");
  });

  it("returns the exact value when present in the target options", () => {
    expect(resolveEffortForOptions({ value: "high", index: 2 }, options)).toBe("high");
  });

  it("falls back to the same index when the value is missing", () => {
    expect(resolveEffortForOptions({ value: "xhigh", index: 1 }, options)).toBe("medium");
  });

  it("clamps an out-of-bounds index to the last available option", () => {
    const shorter = [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
    ];
    expect(resolveEffortForOptions({ value: "xhigh", index: 4 }, shorter)).toBe("medium");
  });

  it("clamps a negative index to zero", () => {
    expect(resolveEffortForOptions({ value: "ghost", index: -3 }, options)).toBe("low");
  });
});
