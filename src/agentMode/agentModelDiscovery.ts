/**
 * Enrolls each agent backend's reported model catalog into the
 * model-management data model on probe settle: every reported model becomes an
 * `origin: "agent"` `ConfiguredModel` so the curation UI and chat picker can
 * show the agent-discovered set.
 *
 * First enrollment of an `agentType` creates the provider and seeds the enabled
 * set to the model the agent reports as current; every later probe only
 * reconciles the model list (no provider-row write), so re-probes don't churn
 * settings.
 *
 * opencode enrolls all its models under a single agent provider, each
 * `ConfiguredModel.info.id` keeping the full prefixed wire form (e.g.
 * `opencode/big-pickle`) so ids stay globally unique and UI sub-grouping can be
 * derived from the wire-id prefix.
 */

import { logError, logInfo } from "@/logger";
import type CopilotPlugin from "@/main";
import type { AgentType, ModelManagementApi, Provider, ProviderType } from "@/modelManagement";
import {
  computeDefaultEnabledIds,
  listBackendDescriptors,
  mapProviderToOpencodeId,
  partitionOpencodeOnlyWireIds,
  type AgentSessionManager,
  type BackendDescriptor,
  type BackendId,
  type BackendState,
} from "@/agentMode";

/**
 * opencode's providerType is bookkeeping only — its models are hosted by
 * opencode and never built by `ChatModelFactory`, so any neutral bucket works.
 */
const PROVIDER_TYPE_BY_AGENT: Record<AgentType, ProviderType> = {
  claude: "anthropic",
  codex: "openai-compatible",
  opencode: "openai-compatible",
};

/**
 * Subscribe (for the plugin's lifetime) to the model cache and enroll each
 * backend's reported models on settle, whether or not the settings tab is open.
 * Returns an unsubscribe function for the host to call on unload.
 *
 * Each fire only enrolls a backend whose reported wire-id set actually changed
 * since its last enrollment, so a settle that notifies repeatedly enrolls at
 * most once. Enrollment runs are serialized per backend so concurrent settles
 * never interleave register/sync writes.
 */
export function wireAgentModelDiscovery(
  plugin: CopilotPlugin,
  manager: AgentSessionManager
): () => void {
  const lastEnrolled = new Map<BackendId, string>();
  const inFlight = new Map<BackendId, Promise<void>>();
  let disposed = false;

  const runForBackend = (descriptor: BackendDescriptor): void => {
    const state = manager.getCachedBackendState(descriptor.id);
    const reported = reportedModels(state);
    if (reported === null) return; // No model state yet — agent hasn't settled.

    // Include the display strings in the signature so a CLI upgrade that
    // renames a model (or rewrites its blurb) re-syncs the persisted info.
    const signature = reported
      .map((r) => `${r.wireId}\t${r.name}\t${r.description ?? ""}`)
      .join("\n");
    if (lastEnrolled.get(descriptor.id) === signature) return; // Unchanged — no-op.

    // The model the agent currently has selected — the one first enrollment
    // seeds as the sole enabled model.
    const currentWireId = state?.model?.current.baseModelId;

    // Chain behind any in-flight run for this backend so two settles can't
    // interleave register/sync writes.
    const prior = inFlight.get(descriptor.id) ?? Promise.resolve();
    const run = prior
      .catch(() => undefined)
      .then(async () => {
        if (disposed) return;
        await enrollBackend(plugin.modelManagement, descriptor, reported, currentWireId);
        // Record the signature only after a successful enroll so a failed
        // run retries on the next settle.
        lastEnrolled.set(descriptor.id, signature);
      })
      .catch((err) => {
        logError(`[AgentMode] model discovery enroll failed for ${descriptor.id}`, err);
      })
      .finally(() => {
        if (inFlight.get(descriptor.id) === run) inFlight.delete(descriptor.id);
      });
    inFlight.set(descriptor.id, run);
  };

  const onCacheUpdate = (): void => {
    if (disposed) return;
    for (const descriptor of listBackendDescriptors()) {
      runForBackend(descriptor);
    }
  };

  const unsubscribe = manager.subscribeModelCache(onCacheUpdate);
  // Run once for any backend whose probe already settled before we
  // subscribed (load-time preload may resolve before this wiring runs).
  onCacheUpdate();

  return () => {
    disposed = true;
    unsubscribe();
  };
}

/**
 * Enroll one backend's reported wire ids through `AgentSetupApi`: first
 * enrollment registers the provider and seeds the enabled set to the agent's
 * current model; later enrollments only reconcile the model list. opencode
 * first drops models it shares with a Copilot-managed provider.
 */
async function enrollBackend(
  api: ModelManagementApi,
  descriptor: BackendDescriptor,
  reported: readonly ReportedModel[],
  currentWireId: string | undefined
): Promise<void> {
  // A backend's id doubles as its model-management AgentType.
  const agentType = descriptor.id as AgentType;
  const reportedWireIds = reported.map((r) => r.wireId);
  const wireModelIds =
    descriptor.id === "opencode" ? suppressManagedOpencode(api, reportedWireIds) : reportedWireIds;

  // Agent-reported display strings, keyed by wire id. Passed as fallbacks so
  // `ConfiguredModel.info.displayName`/`.description` match the chat picker's
  // `ModelEntry` exactly — the agent owns these for agent-origin models.
  const fallbackDisplayNames: Record<string, string> = {};
  const fallbackDescriptions: Record<string, string> = {};
  for (const r of reported) {
    // Both guarded by truthiness so a backend that reports an empty name never
    // overwrites a good catalog/existing displayName with "" (which would strand
    // the row at its raw configuredModelId in the enable list).
    if (r.name) fallbackDisplayNames[r.wireId] = r.name;
    if (r.description) fallbackDescriptions[r.wireId] = r.description;
  }

  // An empty list means a transient/degraded probe (zero models settled, or —
  // for opencode — every model was suppressed as Copilot-managed), NOT "the
  // user removed everything". Syncing it would cascade-remove every enrolled
  // model, so skip and let a later non-empty probe re-enroll.
  if (wireModelIds.length === 0) {
    logInfo(
      `[AgentMode] model discovery: empty model list for ${agentType} — ` +
        `skipping enroll/sync (transient or fully-suppressed probe)`
    );
    return;
  }

  const existing = api.providerRegistry
    .listByOrigin("agent")
    .find((p) => p.origin.kind === "agent" && p.origin.agentType === agentType);

  if (existing) {
    await api.setup.agent.syncAgentModels({
      agentType,
      wireModelIds,
      fallbackDisplayNames,
      fallbackDescriptions,
    });
    return;
  }

  // First enrollment: register the provider (auto-enrolls every model), then
  // narrow the enabled set to the agent's current model.
  const result = await api.setup.agent.registerAgentProvider({
    agentType,
    providerType: PROVIDER_TYPE_BY_AGENT[agentType],
    displayName: descriptor.displayName,
    // No Copilot-side key: claude/codex are CLI-managed and opencode hosts its
    // own models, so the keychain id stays null.
    apiKey: null,
    wireModelIds,
    fallbackDisplayNames,
    fallbackDescriptions,
  });

  // `configuredModelIds` come back in `wireModelIds` order, so zip them to
  // recover each model's wire id for the current-model lookup.
  const enrolled = result.configuredModelIds.map((configuredModelId, i) => ({
    configuredModelId,
    wireModelId: wireModelIds[i],
  }));
  const seeded = computeDefaultEnabledIds(enrolled, currentWireId);

  if (seeded.length !== result.configuredModelIds.length) {
    await api.backendConfigRegistry.setEnabledModels(agentType, seeded);
  }

  logInfo(
    `[AgentMode] model discovery: first enrollment for ${agentType} — ` +
      `${result.configuredModelIds.length} model(s) configured, ${seeded.length} enabled`
  );
}

/**
 * Drop opencode wire ids hosted by a Copilot-managed (BYOK / Plus) provider,
 * keeping only the opencode-only ids. Builds the managed-provider-id set from
 * the registry here (impure) and delegates the filtering to a pure function.
 */
function suppressManagedOpencode(api: ModelManagementApi, reported: readonly string[]): string[] {
  const byokAndPlus = [
    ...api.providerRegistry.listByOrigin("byok"),
    ...api.providerRegistry.listByOrigin("copilot-plus"),
  ];
  const managed = buildManagedOpencodeProviderIds(byokAndPlus);
  return partitionOpencodeOnlyWireIds(reported, managed);
}

/**
 * The opencode provider ids Copilot already manages via the user's BYOK / Plus
 * providers, used to suppress those models from opencode's reported catalog.
 * Agent-origin providers are excluded — they ARE the opencode-only models we
 * want to enroll, so they must never suppress themselves. Unroutable providers
 * map to `null` and contribute nothing.
 */
export function buildManagedOpencodeProviderIds(
  byokAndPlusProviders: readonly Provider[]
): Set<string> {
  const managed = new Set<string>();
  for (const provider of byokAndPlusProviders) {
    if (provider.origin.kind === "agent") continue;
    const mapping = mapProviderToOpencodeId(provider);
    if (!mapping) continue;
    managed.add(mapping.id);
  }
  return managed;
}

/** One agent-reported model: its wire id plus the display strings to persist. */
interface ReportedModel {
  wireId: string;
  name: string;
  description?: string;
}

/**
 * The reported models from a cached `BackendState`, or `null` when the backend
 * hasn't reported a model state yet — distinct from an empty array (a settled
 * state with zero models), which callers treat differently. Carries each
 * model's translated `name`/`description` so enrollment persists the same
 * strings the chat picker shows.
 */
function reportedModels(state: BackendState | null): ReportedModel[] | null {
  if (!state?.model) return null;
  return state.model.availableModels.map((m) => ({
    wireId: m.baseModelId,
    name: m.name,
    description: m.description,
  }));
}
