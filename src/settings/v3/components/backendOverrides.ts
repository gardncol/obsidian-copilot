/**
 * Lightweight read/write helpers for `agentMode.backends.<id>.modelEnabledOverrides`.
 *
 * The legacy helpers in `@/agentMode/session/modelEnable.ts` operate on
 * `BackendDescriptor` instances and only ship for the three "real" backends
 * (opencode / claude / codex). The new Agent panel also needs to persist
 * Quick Chat overrides, which has no descriptor — so we keep a thin,
 * descriptor-free pair of helpers here that work uniformly across all four
 * agent backend slices.
 */
import { getSettings, setSettings, type CopilotSettings } from "@/settings/model";
import type { AgentBackendTabId } from "@/settings/v3/components/BackendSubtabs";
import { logInfo } from "@/logger";

const BYOK_DIAG = true;

/**
 * Read the persisted overrides map for a given backend, or `undefined` when
 * no slice exists. `undefined` means "no overrides written"; callers should
 * default missing entries to visible (true).
 */
export function readBackendOverrides(
  backendId: AgentBackendTabId,
  settings: CopilotSettings = getSettings()
): Record<string, boolean> | undefined {
  const backends = settings.agentMode?.backends as
    | Record<string, { modelEnabledOverrides?: Record<string, boolean> } | undefined>
    | undefined;
  return backends?.[backendId]?.modelEnabledOverrides;
}

/**
 * Write a single `(key, enabled)` toggle into the given backend's slice. The
 * settings atom is mutated through `setSettings(...)` so the rest of the UI
 * (Jotai subscribers) stays in sync. Composes the new map by merging the
 * previous one in — never clobbers other keys.
 */
export function writeBackendOverride(
  backendId: AgentBackendTabId,
  key: string,
  enabled: boolean
): void {
  if (BYOK_DIAG) {
    logInfo("[BYOK-DIAG] writeBackendOverride", { backendId, key, enabled });
  }
  setSettings((cur) => {
    const existing = (cur.agentMode.backends as Record<string, unknown> | undefined)?.[
      backendId
    ] as { modelEnabledOverrides?: Record<string, boolean> } | undefined;
    const prevOverrides = existing?.modelEnabledOverrides ?? {};
    const nextOverrides = { ...prevOverrides, [key]: enabled };
    return {
      agentMode: {
        ...cur.agentMode,
        backends: {
          ...cur.agentMode.backends,
          [backendId]: { ...(existing ?? {}), modelEnabledOverrides: nextOverrides },
        },
      },
    };
  });
}

/**
 * Resolve whether a model is currently visible in the backend's picker. Per
 * §2.2, missing override defaults to `true` (visible).
 */
export function isBackendModelEnabled(
  overrides: Record<string, boolean> | undefined,
  key: string
): boolean {
  if (!overrides) return true;
  const value = overrides[key];
  return value !== false;
}
