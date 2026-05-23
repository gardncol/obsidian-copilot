/**
 * Agent setup workflow. Called by an agent's own setup flow (Claude
 * Code installer, Codex CLI installer, OpenCode installer) when the
 * agent reports its supported model list.
 *
 * Creates one `Provider` row per `(agentType, providerType)` pair
 * with `origin: { kind: "agent", agentType }`, snapshots
 * `ConfiguredModel` rows for each `wireModelId`, and auto-enrolls
 * them into `backends[agentType]` only — agent-owned models stay
 * exclusive to their agent's picker.
 *
 * `registerAgentProvider` is idempotent on
 * `(agentType, providerType)` — re-running upgrades the model list
 * (adds new wire ids, drops vanished ones). `syncAgentModels` is the
 * narrower variant for callers that only need the model-list refresh
 * without provider metadata changes.
 */

import type { CatalogDownloadService } from "@/modelManagement/catalog/CatalogDownloadService";
import type { ModelManagementCoordinator } from "@/modelManagement/createModelManagement";
import type { ProviderType } from "@/modelManagement/types/catalog";
import type { AgentType } from "@/modelManagement/types/persisted";
import type { BackendConfigRegistry } from "@/modelManagement/backends/BackendConfigRegistry";
import type { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import type { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";

export interface RegisterAgentProviderInput {
  agentType: AgentType;
  providerType: ProviderType;
  displayName: string;
  baseUrl?: string;
  /** Agents that use CLI-managed credentials (Claude Code, Codex)
   *  pass `null`. The Provider row's `apiKeyKeychainId` stays
   *  `null`; the chat-model factory's `getApiKey()` returns `null`
   *  and the adapter must tolerate that. */
  apiKey?: string | null;
  /** Per-providerType payload — see `Provider.extras`. */
  extras?: Record<string, unknown>;
  /** Full set of wire ids the agent reports as supported. The
   *  existing ConfiguredModel set is diffed against this list. */
  wireModelIds: readonly string[];
  /** Fallback for wire ids the catalog doesn't know — used when the
   *  agent supports a model that hasn't been added to `models.dev`
   *  yet. Keyed by wire id. */
  fallbackDisplayNames?: Record<string, string>;
}

export interface SyncAgentModelsInput {
  agentType: AgentType;
  wireModelIds: readonly string[];
}

export interface AgentSetupResult {
  providerId: string;
  configuredModelIds: string[];
}

export interface AgentSyncResult {
  added: string[];
  removed: string[];
}

export class AgentSetupApi {
  constructor(
    providerRegistry: ProviderRegistry,
    configuredModelRegistry: ConfiguredModelRegistry,
    backendConfigRegistry: BackendConfigRegistry,
    catalogService: CatalogDownloadService,
    /** Required for the diff-reconcile cascade: when a wire id vanishes
     *  on agent upgrade, the orphan ConfiguredModel and its backend
     *  refs are removed via `coordinator.removeConfiguredModel`. */
    coordinator: ModelManagementCoordinator
  ) {}

  /**
   * Idempotent on `(agentType, providerType)`. First call creates;
   * subsequent calls update the Provider row in place and reconcile
   * the configured-model list (add new wire ids, drop vanished
   * ones). Each new ConfiguredModel is auto-enrolled into
   * `backends[agentType]`.
   *
   * Catalog lookups (via `catalogService`) enrich each
   * `ConfiguredModel.info` snapshot where the wire id matches a
   * catalog entry; unmatched wire ids fall back to
   * `fallbackDisplayNames[wireId] ?? wireId`.
   */
  registerAgentProvider(input: RegisterAgentProviderInput): Promise<AgentSetupResult> {
    throw new Error("[modelManagement] AgentSetupApi.registerAgentProvider not implemented yet");
  }

  /**
   * Reconcile the configured-model list for an existing agent-owned
   * provider. Same diff logic as `registerAgentProvider` but doesn't
   * touch the Provider row.
   */
  syncAgentModels(input: SyncAgentModelsInput): Promise<AgentSyncResult> {
    throw new Error("[modelManagement] AgentSetupApi.syncAgentModels not implemented yet");
  }
}
