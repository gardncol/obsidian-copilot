import type { CopilotSettings } from "@/settings/model";
import type { ConfiguredModel, Provider } from "@/modelManagement";

export interface OpencodeProviderMapping {
  /** The opencode provider id — leading segment of `<provider>/<model>`. */
  id: string;
  /**
   * `true` when opencode hosts the provider itself (an agent-origin provider it
   * discovered): it carries its own auth + model snapshot, so the runtime
   * config must NOT re-register it or inject a key.
   */
  native: boolean;
}

/** opencode provider id reserved for the Copilot Plus brevilabs proxy. */
export const COPILOT_PLUS_OPENCODE_PROVIDER_ID = "copilot-plus";

/** See AGENTS.md → "Referential stability". */
const EMPTY_WIRE_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Map a Copilot `Provider` onto its opencode provider id, or `null` when
 * opencode can't route it (so callers skip it). A BYOK provider with a
 * `catalogProviderId` maps to it (identical to opencode's provider id). A BYOK
 * provider without one has no catalog identity opencode can resolve: when it
 * speaks OpenAI's wire format (`openai-compatible` — Ollama, LM Studio, custom)
 * it's routable as a per-provider `@ai-sdk/openai-compatible` entry keyed by its
 * `providerId` (see `buildOpencodeConfig`); azure / bedrock speak other formats
 * and stay unroutable.
 */
export function mapProviderToOpencodeId(provider: Provider): OpencodeProviderMapping | null {
  switch (provider.origin.kind) {
    case "byok": {
      const catalogProviderId = provider.origin.catalogProviderId;
      if (catalogProviderId) return { id: catalogProviderId, native: false };
      if (provider.providerType === "openai-compatible") {
        // The providerId is unique + stable and can't collide with a real
        // models.dev provider id; it's the wire-id prefix `<providerId>/<model>`.
        return { id: provider.providerId, native: false };
      }
      return null;
    }
    case "copilot-plus":
      return { id: COPILOT_PLUS_OPENCODE_PROVIDER_ID, native: false };
    case "agent":
      // An opencode-discovered provider's id is opencode's own provider id, and
      // opencode hosts the models — native, so no key/registration.
      return { id: provider.providerId, native: true };
    default:
      return null;
  }
}

/**
 * The opencode wire ids for the backend's enabled models, joining
 * `backends.opencode.enabledModels` to the configured-model + provider state.
 * BYOK / Plus models become `${opencodeProviderId}/${info.id}`; agent-origin
 * models use `info.id` verbatim (already the full wire form). Unroutable or
 * missing entries are skipped.
 *
 * Shared by `buildOpencodeConfig` (injection) and the descriptor's picker
 * filter so the injected / enabled / shown sets agree.
 */
export function opencodeEnabledWireIds(settings: CopilotSettings): ReadonlySet<string> {
  const enabledIds = settings.backends.opencode?.enabledModels ?? [];
  if (enabledIds.length === 0) return EMPTY_WIRE_IDS;

  const modelsById = new Map<string, ConfiguredModel>();
  for (const model of settings.configuredModels) {
    modelsById.set(model.configuredModelId, model);
  }

  const wireIds = new Set<string>();
  for (const configuredModelId of enabledIds) {
    const configuredModel = modelsById.get(configuredModelId);
    if (!configuredModel) continue;
    const provider = settings.providers[configuredModel.providerId];
    if (!provider) continue;
    const mapping = mapProviderToOpencodeId(provider);
    if (!mapping) continue;

    if (mapping.native) {
      // Agent-origin: `info.id` is already the full opencode wire form.
      wireIds.add(configuredModel.info.id);
    } else {
      wireIds.add(`${mapping.id}/${configuredModel.info.id}`);
    }
  }

  if (wireIds.size === 0) return EMPTY_WIRE_IDS;
  return wireIds;
}
