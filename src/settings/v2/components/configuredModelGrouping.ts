/** Pure grouping logic for `ConfiguredModelEnableList`, split from the React container so it's testable with plain data. */

import type { ModelEnableGroup, ModelEnableRow } from "@/agentMode";
import type { ConfiguredModel, Provider } from "@/modelManagement";

/** One candidate model joined to its provider, plus current enabled state. */
export interface Candidate {
  configuredModel: ConfiguredModel;
  provider: Provider;
  enabled: boolean;
}

/** The two candidate buckets a backend's configured models partition into. */
export interface CandidatePartition {
  /** BYOK/Plus configured models (opencode candidates only). */
  byokPlusCandidates: Candidate[];
  /** This agent's own agent-origin models. */
  agentOriginCandidates: Candidate[];
}

/**
 * Split configured models into this backend's candidate buckets: agent-origin
 * models matching `agentType`, plus BYOK/Plus models for opencode only.
 *
 * For opencode, a BYOK/Plus provider it can't route (`isOpencodeRoutable`
 * false — azure / bedrock / self-hosted) is dropped to avoid a dead toggle:
 * `opencodeEnabledWireIds` skips unroutable providers at injection and
 * picker-filter time, so enabling one would never reach the agent or picker.
 */
export function partitionCandidates(
  configuredModels: readonly ConfiguredModel[],
  providers: Readonly<Record<string, Provider>>,
  enabledIds: ReadonlySet<string>,
  agentType: string,
  isOpencode: boolean,
  isOpencodeRoutable?: (provider: Provider) => boolean
): CandidatePartition {
  const byokPlusCandidates: Candidate[] = [];
  const agentOriginCandidates: Candidate[] = [];
  for (const configuredModel of configuredModels) {
    const provider = providers[configuredModel.providerId];
    if (!provider) continue;
    const candidate: Candidate = {
      configuredModel,
      provider,
      enabled: enabledIds.has(configuredModel.configuredModelId),
    };
    const origin = provider.origin;
    if (origin.kind === "agent") {
      // Agent-origin models are exclusive to their agent's picker.
      if (origin.agentType === agentType) agentOriginCandidates.push(candidate);
      continue;
    }
    // BYOK / Plus rows are candidates for opencode only — and only when
    // opencode can actually route the provider (no dead toggles).
    if (isOpencode && (origin.kind === "byok" || origin.kind === "copilot-plus")) {
      if (isOpencodeRoutable && !isOpencodeRoutable(provider)) continue;
      byokPlusCandidates.push(candidate);
    }
  }
  return { byokPlusCandidates, agentOriginCandidates };
}

/**
 * The opencode-only sub-group label: the wire-id prefix (e.g.
 * `opencode/big-pickle` → `opencode`). All opencode-only models live under one
 * agent provider with full-prefixed ids, so sub-grouping comes from the prefix,
 * not separate Provider rows. Falls back to the provider name when unprefixed.
 */
export function opencodeOnlySubGroupLabel(model: ConfiguredModel, provider: Provider): string {
  const slash = model.info.id.indexOf("/");
  if (slash > 0) return model.info.id.slice(0, slash);
  return provider.displayName;
}

/** A `ModelEnableRow` from a candidate, surfacing the wire id as a secondary line when it differs from the label. */
export function toRow(candidate: Candidate): ModelEnableRow {
  const { configuredModel, enabled } = candidate;
  const label = configuredModel.info.displayName || configuredModel.info.id;
  return {
    id: configuredModel.configuredModelId,
    label,
    description: label === configuredModel.info.id ? undefined : configuredModel.info.id,
    enabled,
  };
}

/** Case-insensitive match of a row against a (lowercased) search query. */
export function rowMatches(row: ModelEnableRow, q: string): boolean {
  if (!q) return true;
  return (
    row.label.toLowerCase().includes(q) ||
    row.id.toLowerCase().includes(q) ||
    (row.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Provider-grouped rows for the shared list. BYOK/Plus candidates get one
 * always-visible group per provider; agent-origin candidates get collapsible
 * wire-prefix sub-groups for opencode (its catalog floods) or a per-provider
 * group for claude/codex. Groups emptied by `query` are dropped.
 */
export function buildModelEnableGroups(
  partition: CandidatePartition,
  isOpencode: boolean,
  query: string
): ModelEnableGroup[] {
  const q = query.trim().toLowerCase();
  const out: ModelEnableGroup[] = [];

  // BYOK/Plus providers — one group per provider, always visible.
  const byProvider = new Map<string, { label: string; rows: ModelEnableRow[] }>();
  for (const candidate of partition.byokPlusCandidates) {
    const row = toRow(candidate);
    if (!rowMatches(row, q)) continue;
    const key = candidate.provider.providerId;
    const bucket = byProvider.get(key);
    if (bucket) bucket.rows.push(row);
    else byProvider.set(key, { label: candidate.provider.displayName, rows: [row] });
  }
  for (const [key, { label, rows }] of byProvider) {
    out.push({ key: `byok:${key}`, label, collapsible: false, rows });
  }

  // Agent-origin models — opencode-only sub-groups (by wire prefix) or a
  // provider group for claude/codex.
  const bySubGroup = new Map<string, { label: string; rows: ModelEnableRow[] }>();
  for (const candidate of partition.agentOriginCandidates) {
    const label = isOpencode
      ? opencodeOnlySubGroupLabel(candidate.configuredModel, candidate.provider)
      : candidate.provider.displayName;
    const row = toRow(candidate);
    if (!rowMatches(row, q)) continue;
    const bucket = bySubGroup.get(label);
    if (bucket) bucket.rows.push(row);
    else bySubGroup.set(label, { label, rows: [row] });
  }
  for (const [label, { rows }] of bySubGroup) {
    out.push({ key: `agent:${label}`, label, collapsible: isOpencode, rows });
  }

  return out;
}
