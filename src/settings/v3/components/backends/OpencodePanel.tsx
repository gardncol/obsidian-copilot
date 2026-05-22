/**
 * OpencodePanel — Agent sub-panel for the OpenCode backend.
 *
 * Per §5.4.1 the picker section is a UNION of three sources:
 *   1. OpenCode-bundled models (e.g. Big Pickle)
 *   2. Copilot-Plus hosted models (when Plus active)
 *   3. BYOK registry entries (anthropic, openai, openrouter, custom:…)
 *
 * After the M9 fix all three sources share **one** persistence key: the
 * bare wire-form `baseModelId` opencode reports. The per-backend storage
 * path (`agentMode.backends.opencode.modelEnabledOverrides`) already
 * discriminates the backend, so the key never repeats it. Because opencode
 * wire-form ids already carry the provider segment (`anthropic/claude-…`,
 * `openrouter/anthropic/claude-…`), the same `modelId` from two providers
 * resolves to two distinct keys — no collision risk.
 *
 * All three sections source from the OpenCode probe cache
 * (`AgentSessionManager.getCachedBackendState("opencode").model.availableModels`)
 * so the panel and the in-chat picker share one source of truth: whatever
 * OpenCode itself reports. We classify into the three buckets via
 * `listOpencodeBuckets` (leading-segment vs. registered BYOK provider).
 *
 * Never reads global `app` — receives it via props for popout safety.
 */
import {
  listOpencodeBuckets,
  listOpencodePlusModels,
  type ModelEntry,
  type OpencodeModelBuckets,
  type OpencodePlusModel,
} from "@/agentMode";
import { usePlugin } from "@/contexts/PluginContext";
import { ModelRegistry, ProviderRegistry } from "@/modelManagement";
import { useIsPlusUser } from "@/plusUtils";
import { useSettingsValue } from "@/settings/model";
import {
  BackendModelPicker,
  type BackendModelPickerRow,
  type BackendModelPickerSection,
} from "@/settings/v3/components/BackendModelPicker";
import {
  isBackendModelEnabled,
  readBackendOverrides,
  writeBackendOverride,
} from "@/settings/v3/components/backendOverrides";
import { findDescriptor } from "@/settings/v3/components/backendPanelHelpers";
import { logError } from "@/logger";
import type { App } from "obsidian";
import React from "react";

interface OpencodePanelProps {
  app: App;
  onManageInByok?: () => void;
}

export const OpencodePanel: React.FC<OpencodePanelProps> = ({ app, onManageInByok }) => {
  const settings = useSettingsValue();
  const plugin = usePlugin();
  const manager = plugin.agentSessionManager;
  // The bucket classifier consults `ModelRegistry`, so the panel must
  // re-classify whenever the user picks/unpicks BYOK models. Use the
  // settings-driven registry array (stable identity per render unless
  // changed) as the trigger.
  const registrySignal = settings.registry;
  // Memoize the registry handle so the bucket-fetch `useEffect` doesn't
  // re-fire every render. In production `getInstance()` returns a stable
  // singleton, but test mocks frequently return a fresh object on every
  // call, which would otherwise blow up the deps array on each render.
  const providerRegistry = React.useMemo(() => ProviderRegistry.getInstance(), []);
  const modelRegistry = React.useMemo(() => ModelRegistry.getInstance(), []);

  const descriptor = findDescriptor("opencode");

  const installState = descriptor?.getInstallState(settings) ?? { kind: "absent" as const };
  const overrides = readBackendOverrides("opencode");

  // Trigger a probe when ready but nothing's cached — same pattern as the
  // legacy AgentSettings: catches binary-installed-after-load.
  React.useEffect(() => {
    if (!manager) return;
    if (installState.kind !== "ready") return;
    const cached = manager.getCachedBackendState("opencode");
    if (cached) return;
    manager
      .preloadModels("opencode")
      .catch((e) => logError("[AgentMode] preload opencode failed", e));
  }, [manager, installState.kind]);

  // ---- Source #1+#3: probe-state buckets --------------------------------
  //
  // `listOpencodeBuckets` returns null when no probe has populated the
  // cache yet (binary missing, probe still running, mobile). We surface
  // that as a per-section empty-state below.
  const [buckets, setBuckets] = React.useState<
    { status: "loading" } | { status: "ready"; value: OpencodeModelBuckets | null }
  >({ status: "loading" });
  React.useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const value = await listOpencodeBuckets(manager ?? null, providerRegistry, modelRegistry);
        if (!cancelled) setBuckets({ status: "ready", value });
      } catch (err) {
        logError("[AgentMode] OpencodePanel: listOpencodeBuckets failed", err);
        if (!cancelled) setBuckets({ status: "ready", value: null });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [manager, providerRegistry, modelRegistry, registrySignal]);
  React.useEffect(() => {
    if (!manager) return;
    return manager.subscribeModelCache(() => {
      void listOpencodeBuckets(manager, providerRegistry, modelRegistry).then(
        (value) => setBuckets({ status: "ready", value }),
        (err) => {
          logError("[AgentMode] OpencodePanel: listOpencodeBuckets failed", err);
          setBuckets({ status: "ready", value: null });
        }
      );
    });
  }, [manager, providerRegistry, modelRegistry, registrySignal]);

  // ---- Source #2: Copilot-Plus hosted models ----------------------------
  //
  // Gated by `useIsPlusUser`. When the user isn't Plus, the section is
  // suppressed entirely — no empty-state copy, no row count.
  const isPlusUser = useIsPlusUser();
  const [plusFallback, setPlusFallback] = React.useState<OpencodePlusModel[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const rows = isPlusUser ? await listOpencodePlusModels() : [];
        if (!cancelled) setPlusFallback(rows);
      } catch (err) {
        logError("[AgentMode] OpencodePanel: listPlusModels failed", err);
        if (!cancelled) setPlusFallback([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isPlusUser]);

  // ---- Compose the sectioned picker -------------------------------------
  const toRow = (entry: ModelEntry): BackendModelPickerRow => ({
    key: entry.baseModelId,
    name: entry.name || entry.baseModelId,
    providerLabel: entry.provider ?? undefined,
    meta: entry.description,
    enabled: isBackendModelEnabled(overrides, entry.baseModelId),
  });

  const bundledRows: BackendModelPickerRow[] =
    buckets.status === "ready" && buckets.value ? buckets.value.bundled.map(toRow) : [];
  const byokRows: BackendModelPickerRow[] =
    buckets.status === "ready" && buckets.value ? buckets.value.byok.map(toRow) : [];

  // Plus rows: prefer the probe-state ones (their `baseModelId` matches
  // exactly what the runtime sees). Fall back to the hard-coded
  // `PLUS_MODELS` list only when the probe hasn't populated yet, so the
  // section never blinks empty for a Plus user on a fresh load.
  const plusFromProbe =
    buckets.status === "ready" && buckets.value ? buckets.value.plus.map(toRow) : [];
  const plusFromFallback: BackendModelPickerRow[] = plusFallback.map((m) => {
    const key = `copilot-plus/${m.id}`;
    return {
      key,
      name: m.displayName,
      meta: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : undefined,
      enabled: isBackendModelEnabled(overrides, key),
    };
  });
  const plusRows: BackendModelPickerRow[] =
    plusFromProbe.length > 0 || buckets.status === "ready" ? plusFromProbe : plusFromFallback;

  /**
   * Empty-state copy for the Bundled section depends on _why_ it's empty:
   *   - `loading`: probe still running — show a "Loading…" placeholder.
   *   - `ready` + `value === null`: OpenCode not installed / unreachable.
   *   - `ready` + non-null but no bundled rows: OpenCode responded but has
   *     nothing to surface beyond BYOK / Plus.
   */
  let bundledPlaceholder: string;
  if (buckets.status === "loading") {
    bundledPlaceholder = "Loading OpenCode-bundled models…";
  } else if (buckets.value === null) {
    bundledPlaceholder = "OpenCode is not installed. Install it below to see bundled models.";
  } else {
    bundledPlaceholder = "OpenCode reports no bundled models yet.";
  }

  const byokPlaceholder =
    buckets.status === "ready" && buckets.value !== null
      ? "Add an agent-capable model in the BYOK tab to see it here once OpenCode reports it."
      : "Install OpenCode to preview your BYOK models here.";

  const sections: BackendModelPickerSection[] = [
    {
      title: "OpenCode-bundled",
      rows: bundledRows,
      emptyPlaceholder: bundledPlaceholder,
    },
  ];
  if (isPlusUser) {
    sections.push({
      title: "Copilot Plus",
      rows: plusRows,
      emptyPlaceholder: "Copilot Plus is active but no hosted models are available right now.",
    });
  }
  sections.push({
    title: "From BYOK",
    rows: byokRows,
    emptyPlaceholder: byokPlaceholder,
  });

  const Panel = descriptor?.SettingsPanel;

  return (
    <div className="tw-space-y-4">
      {Panel && <Panel plugin={plugin} app={app} />}

      <BackendModelPicker
        sections={sections}
        onManageInByok={onManageInByok}
        onToggle={(key, enabled) => writeBackendOverride("opencode", key, enabled)}
      />
    </div>
  );
};
