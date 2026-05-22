import { Notice } from "obsidian";
import { logError, logInfo } from "@/logger";

const BYOK_DIAG = true;
import type { ModelSelectorEntry } from "@/components/ui/ModelSelector";
import { isAgentModelEnabledOrKept } from "@/agentMode/session/modelEnable";
import type { AgentSession } from "@/agentMode/session/AgentSession";
import type { AgentChatUIState } from "@/agentMode/session/AgentChatUIState";
import type {
  AgentSessionManager,
  EffortPreference,
} from "@/agentMode/session/AgentSessionManager";
import { MethodUnsupportedError } from "@/agentMode/session/errors";
import { backendRegistry } from "@/agentMode/backends/registry";
import { getBackendModelOverrides } from "@/agentMode/session/backendSettingsAccess";
import { getModelKeyFromModel } from "@/settings/model";
import type { CopilotSettings } from "@/settings/model";
import type {
  BackendDescriptor,
  BackendId,
  BackendState,
  ModelEntry,
  ModelState,
} from "@/agentMode/session/types";
import type { AgentModelPickerOverride } from "./useAgentModelPicker";

/**
 * Pick the BackendState that should drive the picker's *current selection*
 * display: prefer the active session's live state, fall back to the
 * per-backend preloader cache only when the session has nothing reportable
 * yet (e.g. the brief "starting" window). The cache is shared across every
 * session on the same backend, so reading it directly leaks a sibling
 * tab's most recent setModel into this tab's picker.
 */
export function resolveActiveDisplayState(
  activeSessionState: BackendState | null,
  activeBackendId: BackendId | null,
  getCachedBackendState: (id: BackendId) => BackendState | null
): BackendState | null {
  if (activeSessionState) return activeSessionState;
  if (!activeBackendId) return null;
  return getCachedBackendState(activeBackendId);
}

/**
 * Standard catch handler for picker `apply*` calls. `MethodUnsupportedError`
 * surfaces a targeted notice; anything else is logged and surfaced as a
 * generic failure.
 */
export function handlePickerSwitchError(err: unknown, action: "model" | "effort" | "mode"): void {
  if (err instanceof MethodUnsupportedError) {
    new Notice(`This agent doesn't support runtime ${action} switching.`);
    return;
  }
  logError(`[AgentMode] ${action} apply failed`, err);
  new Notice(`Failed to switch ${action}. See console for details.`);
}

/** A pseudo-provider value used for agent-only synthesized entries. */
export const AGENT_PROVIDER = "agent";

/**
 * Append one backend's section to the picker. Entries are synthesized from
 * the backend's catalog (`backendModels`) gated by the user's per-model
 * overrides; the active session's selection is preserved via
 * `keepBaseModelId` so curation never strands it.
 */
export function appendBackendSection(
  entries: ModelSelectorEntry[],
  descriptor: BackendDescriptor,
  ctx: {
    /** Translator-produced entries from `state.model.availableModels`. */
    backendModels: ReadonlyArray<ModelEntry> | null;
    overrides: Record<string, boolean> | undefined;
    /** baseModelId of the active session — never filtered out. */
    keepBaseModelId: string | null;
  }
): void {
  if (!ctx.backendModels) return;
  const filtered = ctx.backendModels.filter((entry) =>
    isAgentModelEnabledOrKept(
      descriptor,
      { modelId: entry.baseModelId, name: entry.name },
      ctx.overrides,
      ctx.keepBaseModelId
    )
  );
  if (BYOK_DIAG && descriptor.id === "opencode") {
    const filteredIds = new Set(filtered.map((m) => m.baseModelId));
    const drops = ctx.backendModels
      .filter((m) => !filteredIds.has(m.baseModelId))
      .map((entry) => ({
        baseModelId: entry.baseModelId,
        name: entry.name,
        override: ctx.overrides?.[entry.baseModelId],
        defaultEnabled:
          descriptor.isModelEnabledByDefault?.({
            modelId: entry.baseModelId,
            name: entry.name,
          }) ?? null,
        keepBaseModelId: ctx.keepBaseModelId,
      }));
    logInfo("[BYOK-DIAG] appendBackendSection opencode", {
      total: ctx.backendModels.length,
      kept: filtered.length,
      droppedCount: drops.length,
      drops,
    });
  }
  for (const m of filtered) {
    entries.push(synthesizeAgentEntry(m.baseModelId, m.name, descriptor));
  }
}

export function synthesizeAgentEntry(
  baseModelId: string,
  humanName: string,
  descriptor: BackendDescriptor
): ModelSelectorEntry {
  return {
    name: baseModelId,
    provider: AGENT_PROVIDER,
    enabled: true,
    isBuiltIn: false,
    displayName: humanName || baseModelId,
    _group: descriptor.displayName,
    _backendId: descriptor.id,
  };
}

/**
 * Synthesize a non-selectable placeholder row for a backend whose preload
 * hasn't settled yet (status `"pending"`) or failed (status `"error"`).
 * `_disabledReason` is the contract `ModelSelector` / `ModelEffortPicker`
 * use to disable the row and display the right-side label.
 */
export function synthesizePreloadPlaceholder(
  descriptor: BackendDescriptor,
  status: "pending" | "error"
): ModelSelectorEntry {
  const pending = status === "pending";
  return {
    ...synthesizeAgentEntry(
      `__preload_${status}__`,
      pending ? "Loading models…" : "Failed to load",
      descriptor
    ),
    _disabledReason: pending ? "Loading…" : "Unavailable",
  };
}

/**
 * Resolve a picker entry to its baseModelId. All picker entries from agent
 * backends are synthesized — the baseModelId lives in `name`.
 */
export function resolveBaseModelId(entry: ModelSelectorEntry): string | undefined {
  return entry.provider === AGENT_PROVIDER ? entry.name : undefined;
}

/**
 * Pick the effort value to apply to a model swap, given the user's last
 * explicit effort intent and the target model's effort options. Fallback
 * cascade: (1) exact value match, (2) same index, (3) clamp to last
 * available index. Returns `null` when the target has no effort options
 * (the model doesn't expose effort at all) or when there is no recorded
 * preference and the target has no options.
 *
 * Match on `value` rather than `label` because `value` is the stable
 * identifier the backend dispatches against; today's labels happen to be
 * the lowercased values but that's a translation-layer detail.
 */
export function resolveEffortForOptions(
  preference: EffortPreference | null,
  options: ReadonlyArray<{ value: string | null; label: string }>
): string | null {
  if (options.length === 0) return null;
  if (!preference) return options[0].value;
  const exact = options.find((o) => o.value === preference.value);
  if (exact) return exact.value;
  const idx = Math.min(Math.max(preference.index, 0), options.length - 1);
  return options[idx].value;
}

/** Bundle of session-derived inputs every model+effort builder needs. */
export interface ModelActiveContext {
  activeSession: AgentSession | null;
  activeChatUIState: AgentChatUIState | null;
  activeBackendId: BackendId | null;
  activeDescriptor: BackendDescriptor | undefined;
  activeSessionHasHistory: boolean;
  activeModelState: ModelState | null;
  activeCurrentEntry: ModelEntry | undefined;
}

export function collectModelActiveContext(manager: AgentSessionManager): ModelActiveContext {
  const activeSession = manager.getActiveSession();
  const activeChatUIState = manager.getActiveChatUIState();
  const activeBackendId = activeSession?.backendId ?? null;
  const activeDescriptor = activeBackendId ? backendRegistry[activeBackendId] : undefined;
  const activeSessionHasHistory = activeSession?.hasUserVisibleMessages() ?? false;
  const activeState = resolveActiveDisplayState(
    activeSession?.getState() ?? null,
    activeBackendId,
    (id) => manager.getCachedBackendState(id)
  );
  const activeModelState = activeState?.model ?? null;
  const activeCurrentEntry = activeModelState?.availableModels.find(
    (e) => e.baseModelId === activeModelState.current.baseModelId
  );
  return {
    activeSession,
    activeChatUIState,
    activeBackendId,
    activeDescriptor,
    activeSessionHasHistory,
    activeModelState,
    activeCurrentEntry,
  };
}

/**
 * Build one entry per registered backend (filtered by overrides and
 * sticky-selection preservation), then locate the active selection. If
 * curation stranded the user's current model, prepend a synthesized entry
 * so it remains visible. Returns the entries array and the resolved
 * `valueKey`.
 */
export function buildPickerEntries(
  manager: AgentSessionManager,
  descriptors: BackendDescriptor[],
  ctx: ModelActiveContext,
  settings: CopilotSettings
): { entries: ModelSelectorEntry[]; valueKey: string } {
  const entries: ModelSelectorEntry[] = [];
  for (const descriptor of descriptors) {
    const isActiveBackend = descriptor.id === ctx.activeBackendId;
    if (!isActiveBackend && ctx.activeSessionHasHistory) {
      if (BYOK_DIAG && descriptor.id === "opencode") {
        logInfo("[BYOK-DIAG] buildPickerEntries opencode skipped", {
          reason: "not active backend && active session has history",
          activeBackendId: ctx.activeBackendId,
          activeSessionHasHistory: ctx.activeSessionHasHistory,
        });
      }
      continue;
    }
    const cached = manager.getCachedBackendState(descriptor.id);
    const keepBaseModelId = isActiveBackend
      ? (ctx.activeModelState?.current.baseModelId ?? null)
      : (manager.getLastSelection(descriptor.id)?.baseModelId ?? null);
    const backendModels = cached?.model?.availableModels ?? null;
    const overrides = getBackendModelOverrides(settings, descriptor.id);
    if (BYOK_DIAG && descriptor.id === "opencode") {
      logInfo("[BYOK-DIAG] buildPickerEntries opencode", {
        isActiveBackend,
        activeSessionHasHistory: ctx.activeSessionHasHistory,
        keepBaseModelId,
        backendModels: backendModels?.map((m) => m.baseModelId) ?? null,
        overrides: overrides ?? null,
      });
    }
    appendBackendSection(entries, descriptor, {
      backendModels,
      overrides,
      keepBaseModelId,
    });
    // No catalog cached yet (and not because the agent intentionally
    // omitted a model state). Show a per-backend loading / failure row so
    // the user can see every installed backend immediately — important
    // because the chat now unblocks on just the *active* backend's
    // preload, not the global preload.
    if (!backendModels) {
      const status = manager.getPreloadStatus(descriptor.id);
      if (status === "pending" || status === "error") {
        entries.push(synthesizePreloadPlaceholder(descriptor, status));
      }
    }
  }

  let valueKey = "";
  if (
    ctx.activeBackendId &&
    ctx.activeDescriptor &&
    ctx.activeModelState &&
    ctx.activeCurrentEntry
  ) {
    const baseId = ctx.activeModelState.current.baseModelId;
    const match = entries.find(
      (e) => e._backendId === ctx.activeBackendId && resolveBaseModelId(e) === baseId
    );
    if (match) {
      valueKey = getModelKeyFromModel(match);
    } else {
      const synth = synthesizeAgentEntry(baseId, ctx.activeCurrentEntry.name, ctx.activeDescriptor);
      entries.unshift(synth);
      valueKey = getModelKeyFromModel(synth);
    }
  }

  return { entries, valueKey };
}

/**
 * Look up the `effortOptions` for a `(backendId, baseModelId)` pair.
 * Reads the active session's translated state for the active backend (more
 * authoritative than the shared per-backend cache, which can lag a
 * sibling-tab swap) and the cached `BackendState` for any other backend.
 * Returns `[]` when the model isn't in the catalog yet.
 */
function lookupEffortOptions(
  manager: AgentSessionManager,
  ctx: ModelActiveContext,
  backendId: BackendId,
  baseModelId: string
): ReadonlyArray<{ value: string | null; label: string }> {
  const modelState =
    ctx.activeBackendId === backendId
      ? ctx.activeModelState
      : (manager.getCachedBackendState(backendId)?.model ?? null);
  const entry = modelState?.availableModels.find((e) => e.baseModelId === baseModelId);
  return entry?.effortOptions ?? [];
}

/**
 * Build the optional effort sibling. Returns `undefined` when the active
 * model has no effort options. `disabled` mirrors
 * `activeChatUIState.canSwitchEffort()` — wire routing
 * (descriptor-style vs suffix-style) lives behind that intent method.
 */
export function buildEffortSibling(
  manager: AgentSessionManager,
  ctx: ModelActiveContext
): AgentModelPickerOverride["effort"] {
  const { activeBackendId, activeCurrentEntry, activeModelState, activeChatUIState } = ctx;
  if (!activeBackendId || !activeCurrentEntry) return undefined;
  if (activeCurrentEntry.effortOptions.length === 0) return undefined;
  if (!activeModelState) return undefined;
  const effortOptions = activeCurrentEntry.effortOptions;
  return {
    options: effortOptions,
    value: activeModelState.current.effort,
    disabled: activeChatUIState?.canSwitchEffort() === false,
    onChange: (value) => {
      // Record the user's explicit intent before applying — the index here
      // anchors the same-index fallback used when this preference is later
      // re-resolved against a different model's effort options.
      const index = effortOptions.findIndex((o) => o.value === value);
      manager.setUserEffortPreference(value, index >= 0 ? index : 0);
      manager
        .applySelection({ effort: value }, { expectBackendId: activeBackendId })
        .catch((err) => {
          handlePickerSwitchError(err, "effort");
        });
    },
  };
}

/**
 * Remember the picked (model, effort) for the target backend, then spawn a
 * fresh session on it. `createSession` reads the remembered selection back
 * out via `getLastSelection` to seed the new session.
 */
function runCrossBackendPick(
  manager: AgentSessionManager,
  oldSessionId: string | undefined,
  targetBackendId: BackendId,
  targetDescriptor: BackendDescriptor,
  baseModelId: string,
  effort: string | null
): void {
  void (async () => {
    try {
      manager.rememberLastSelection(targetBackendId, { baseModelId, effort });
      await manager.createSession(targetBackendId);
      manager.setDefaultBackend(targetBackendId);
      if (oldSessionId) {
        void manager
          .closeSession(oldSessionId)
          .catch((e) => logError("[AgentMode] closeSession of empty tab failed", e));
      }
    } catch (err) {
      logError("[AgentMode] cross-backend pick failed", err);
      new Notice(`Failed to start ${targetDescriptor.displayName}. See console for details.`);
    }
  })();
}

/**
 * Build the model picker's `onChange` callback. Cross-backend picks seed
 * a fresh session on the target backend with the chosen model + the best
 * effort the target supports (the most recently remembered selection on
 * that backend wins; otherwise the user's global effort intent is
 * re-resolved against the target model's options). The old empty tab is
 * closed in the background. Same-backend picks route through the running
 * session via `applySelection` with the effort re-resolved against the
 * new model's options so the user's intent carries across models with
 * differing effort vocabularies (or no effort at all).
 */
export function buildModelOnChange(
  manager: AgentSessionManager,
  ctx: ModelActiveContext,
  entries: ModelSelectorEntry[]
): (modelKey: string) => void {
  const { activeSession, activeChatUIState } = ctx;
  return (modelKey) => {
    const entry = entries.find((e) => getModelKeyFromModel(e) === modelKey);
    if (!entry) return;
    const targetBackendId = entry._backendId;
    if (!targetBackendId) {
      logError("[AgentMode] picker entry missing _backendId", entry);
      return;
    }
    const targetDescriptor = backendRegistry[targetBackendId];
    if (!targetDescriptor) {
      logError("[AgentMode] picker entry references unknown backend", targetBackendId);
      return;
    }
    const baseModelId = resolveBaseModelId(entry);
    if (!baseModelId) {
      new Notice("Could not resolve a model id for this selection.");
      return;
    }

    if (!activeSession || activeSession.backendId !== targetBackendId) {
      const targetOptions = lookupEffortOptions(manager, ctx, targetBackendId, baseModelId);
      const rememberedEffort = manager.getLastSelection(targetBackendId)?.effort;
      // Prefer the user's most-recent explicit pick on that backend.
      // Fall back to re-resolving the global effort intent against the
      // target model's options (handles "first time on this backend").
      const seedEffort =
        rememberedEffort !== undefined
          ? rememberedEffort
          : resolveEffortForOptions(manager.getUserEffortPreference(), targetOptions);
      runCrossBackendPick(
        manager,
        activeSession?.internalId,
        targetBackendId,
        targetDescriptor,
        baseModelId,
        seedEffort
      );
      return;
    }
    // Same backend: flip the default eagerly, then route through the
    // running session.
    manager.setDefaultBackend(targetBackendId);
    if (activeChatUIState?.canSwitchModel() === false) {
      new Notice("This agent doesn't support runtime model switching.");
      return;
    }
    // Re-resolve the user's effort intent against the new model's options
    // so a model swap doesn't silently snap to `low` when the previous
    // effort label isn't present on the target (or doesn't exist at all).
    const targetOptions = lookupEffortOptions(manager, ctx, targetBackendId, baseModelId);
    const resolvedEffort = resolveEffortForOptions(
      manager.getUserEffortPreference(),
      targetOptions
    );
    manager.applySelection({ baseModelId, effort: resolvedEffort }).catch((err) => {
      handlePickerSwitchError(err, "model");
    });
  };
}

/**
 * Build the per-entry effort catalog used by the merged model+effort picker.
 * Keyed by `getModelKeyFromModel(entry)` so the picker can look up effort
 * options for any highlighted row, not just the active one.
 */
export function buildEffortOptionsByModelKey(
  manager: AgentSessionManager,
  descriptors: BackendDescriptor[],
  entries: ModelSelectorEntry[]
): Record<string, { label: string; value: string | null }[]> {
  const out: Record<string, { label: string; value: string | null }[]> = {};
  // Cache per-backend catalog lookups
  const catalogByBackendId = new Map<string, ReadonlyArray<ModelEntry> | null>();
  for (const d of descriptors) {
    catalogByBackendId.set(
      d.id,
      manager.getCachedBackendState(d.id)?.model?.availableModels ?? null
    );
  }
  for (const entry of entries) {
    const backendId = entry._backendId;
    const baseModelId = resolveBaseModelId(entry);
    if (!backendId || !baseModelId) continue;
    const catalog = catalogByBackendId.get(backendId);
    if (!catalog) continue;
    const found = catalog.find((m) => m.baseModelId === baseModelId);
    out[getModelKeyFromModel(entry)] = found ? found.effortOptions : [];
  }
  return out;
}

/**
 * Build the atomic `(model, effort)` commit callback used by the merged
 * picker. Same-backend picks push both fields through `applySelection` in
 * one call (which also updates the in-memory last-selection cache).
 * Cross-backend picks remember the drafted `(baseModelId, effort)` on
 * the target backend and seed a fresh session on it — the user's effort
 * choice survives the backend swap.
 */
export function buildCommitSelection(
  manager: AgentSessionManager,
  ctx: ModelActiveContext,
  entries: ModelSelectorEntry[],
  modelOnChange: (modelKey: string) => void
): (modelKey: string, effort: string | null) => void {
  const { activeSession, activeChatUIState } = ctx;
  return (modelKey, effort) => {
    const entry = entries.find((e) => getModelKeyFromModel(e) === modelKey);
    if (!entry) return;
    const baseModelId = resolveBaseModelId(entry);
    const targetBackendId = entry._backendId;
    if (!baseModelId || !targetBackendId) {
      modelOnChange(modelKey);
      return;
    }
    const targetDescriptor = backendRegistry[targetBackendId];
    if (!targetDescriptor) {
      logError("[AgentMode] commitSelection references unknown backend", targetBackendId);
      return;
    }
    // The atomic commit is the user explicitly picking an effort against a
    // specific model — record it as the new global intent so subsequent
    // model swaps re-resolve against this index, even if they pass through
    // a model whose effort vocabulary doesn't contain this value.
    const targetOptions = lookupEffortOptions(manager, ctx, targetBackendId, baseModelId);
    if (targetOptions.length > 0) {
      const index = targetOptions.findIndex((o) => o.value === effort);
      manager.setUserEffortPreference(effort, index >= 0 ? index : 0);
    }
    if (!activeSession || activeSession.backendId !== targetBackendId) {
      runCrossBackendPick(
        manager,
        activeSession?.internalId,
        targetBackendId,
        targetDescriptor,
        baseModelId,
        effort
      );
      return;
    }
    if (activeChatUIState?.canSwitchModel() === false) {
      new Notice("This agent doesn't support runtime model switching.");
      return;
    }
    manager.applySelection({ baseModelId, effort }).catch((err) => {
      handlePickerSwitchError(err, "model");
    });
  };
}

/**
 * Outer orchestrator — builds the full model+effort `AgentModelPickerOverride`.
 */
export function buildAgentModelPicker(args: {
  manager: AgentSessionManager | null;
  descriptors: BackendDescriptor[];
  settings: CopilotSettings;
}): AgentModelPickerOverride | null {
  const { manager, descriptors, settings } = args;
  if (!manager) return null;
  const ctx = collectModelActiveContext(manager);
  const { entries, valueKey } = buildPickerEntries(manager, descriptors, ctx, settings);
  const onChange = buildModelOnChange(manager, ctx, entries);
  return {
    models: entries,
    value: valueKey,
    disabled: false,
    effort: buildEffortSibling(manager, ctx),
    effortOptionsByModelKey: buildEffortOptionsByModelKey(manager, descriptors, entries),
    onChange,
    commitSelection: buildCommitSelection(manager, ctx, entries, onChange),
  };
}
