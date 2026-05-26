import type { CopilotSettings } from "@/settings/model";
import type { ConfiguredModel } from "@/modelManagement";

/** See AGENTS.md → "Referential stability". */
const EMPTY_WIRE_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** A descriptor's own `wire.decode`, accepted as a parameter so this backend-layer helper needn't import the session-domain codec type. */
export type WireDecode = (wireId: string) => { selection: { baseModelId: string } };

/**
 * The wire baseModelIds for a claude / codex backend's enabled models —
 * each enabled `ConfiguredModel.info.id` decoded via the descriptor's
 * `wire.decode`. Used by the descriptor's `getEnabledBaseModelIds` so the
 * enabled and picker-shown sets agree.
 *
 * Only for all-agent-origin backends; opencode mixes in BYOK/Plus models and
 * uses `opencodeEnabledWireIds` instead.
 */
export function agentOriginEnabledWireIds(
  settings: CopilotSettings,
  agentType: "claude" | "codex",
  wireDecode: WireDecode
): ReadonlySet<string> {
  const enabledIds = settings.backends[agentType]?.enabledModels ?? [];
  if (enabledIds.length === 0) return EMPTY_WIRE_IDS;

  const modelsById = new Map<string, ConfiguredModel>();
  for (const model of settings.configuredModels) {
    modelsById.set(model.configuredModelId, model);
  }

  const wireIds = new Set<string>();
  for (const configuredModelId of enabledIds) {
    const configuredModel = modelsById.get(configuredModelId);
    if (!configuredModel) continue;
    // `info.id` is the agent-reported wire id; decode it to the baseModelId
    // the picker compares against `ModelEntry.baseModelId`.
    wireIds.add(wireDecode(configuredModel.info.id).selection.baseModelId);
  }

  if (wireIds.size === 0) return EMPTY_WIRE_IDS;
  return wireIds;
}
