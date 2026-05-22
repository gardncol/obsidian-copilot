/**
 * bundledModels — surface OpenCode's enumeration of its own bundled models.
 *
 * Per M8 of the Model Management redesign (designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §5.4.1):
 * the OpenCode panel's picker is a UNION of three sources, and source #1 —
 * "OpenCode-bundled (Big Pickle, etc.)" — comes from whatever OpenCode itself
 * reports via its session catalog. We don't query the binary directly; instead
 * we lean on `AgentSessionManager.getCachedBackendState("opencode")` which
 * `AgentModelPreloader` has already populated by booting a probe session at
 * plugin load. That probe is the only ACP-supported way to ask OpenCode "what
 * models do you know about"; running another query at panel-render time would
 * spin up an extra subprocess for no gain.
 *
 * What counts as "bundled" vs "BYOK" vs "Plus"?
 *   - Each `availableModels` entry's leading wire-form segment names its
 *     OpenCode-side provider. We bucket as follows:
 *     · `copilot-plus/...` → Plus (our brevilabs-routed pseudo-provider).
 *     · leading segment matches a registered BYOK provider id
 *       (`ProviderRegistry.get(segment)`) → BYOK row. This catches built-ins
 *       (`anthropic`, `openai`, `groq`, …) AND custom providers
 *       (`custom:<uuid>`), since both register under the same id on both
 *       sides per `byokBridge.ts:resolveOpencodeProviderId`.
 *     · anything else → bundled (OpenCode-native, e.g. `bigpickle/big-pickle`).
 *
 * Fallback: if the cached state is unavailable (OpenCode not installed, probe
 * still running, mobile platform), the function returns `null` so the panel
 * can render its "OpenCode not installed" empty-state. The bridge / panel
 * never blocks on a live JSON-RPC call here.
 */
import type { AgentSessionManager } from "@/agentMode/session/AgentSessionManager";
import type { BackendState, ModelEntry } from "@/agentMode/session/types";
import { logInfo } from "@/logger";

const BYOK_DIAG = true;

/**
 * One bundled-model row, shaped for the panel's `BackendModelPickerRow`
 * consumers. `id` is the modelId-form key (matches OpenCode's
 * `baseModelId`); `displayName` is the user-visible label.
 */
export interface BundledModel {
  /** Stable model id used as the row's persistence key (without provider prefix). */
  id: string;
  /** Human-readable label (e.g. "Big Pickle"). */
  displayName: string;
  /** OpenCode provider segment (e.g. "bigpickle"). Useful for grouping. */
  provider?: string;
  /** Catalog-declared context window when known. Currently unset. */
  contextWindow?: number;
}

/** OpenCode provider segment reserved for our brevilabs-routed Plus models. */
const COPILOT_PLUS_SEGMENT = "copilot-plus";

/**
 * The three buckets the OpenCode panel renders, populated from a single
 * `availableModels` pass so the classification is consistent across sources.
 */
export interface OpencodeModelBuckets {
  bundled: ModelEntry[];
  byok: ModelEntry[];
  plus: ModelEntry[];
}

/**
 * Minimal `ProviderRegistry` shape the classifier needs. Threaded in as a
 * parameter rather than imported as a singleton so the helper stays
 * test-able without pulling the whole settings layer (see `AGENTS.md`,
 * "Avoiding Deep Dependency Chains in Tests").
 */
export interface ProviderRegistryLike {
  get(id: string): unknown;
}

/**
 * Minimal `ModelRegistry` shape the classifier needs. Same rationale as
 * `ProviderRegistryLike` — passed in so the helper doesn't have to pull
 * the whole settings layer.
 */
export interface ModelRegistryLike {
  get(providerId: string, modelId: string): unknown;
}

/**
 * Classify an OpenCode `availableModels` list into the three picker buckets.
 *
 * The leading wire-form segment names the OpenCode-side provider id and the
 * remainder is the BYOK registry's `modelId` (per `byokBridge.ts:142`, which
 * writes entries verbatim into `provider.<id>.models.<modelId>`). To
 * distinguish a model the user actually picked from OpenCode's bundled
 * `models.dev` snapshot for the same provider, we require **both**:
 *
 *   1. the leading segment matches a registered BYOK provider, AND
 *   2. the `(providerId, suffix)` pair exists in `ModelRegistry`.
 *
 * Rows whose leading segment matches a BYOK provider but whose suffix is
 * NOT in `ModelRegistry` are OpenCode's bundled snapshot for that provider
 * (e.g. all ~50 `openrouter/*` rows when the user only picked 2). They're
 * dropped — neither BYOK nor bundled — since the user didn't opt into them
 * and they'd be unusable without an explicit pick.
 */
export function classifyOpencodeModels(
  entries: ModelEntry[],
  providerRegistry: ProviderRegistryLike,
  modelRegistry: ModelRegistryLike
): OpencodeModelBuckets {
  const bundled: ModelEntry[] = [];
  const byok: ModelEntry[] = [];
  const plus: ModelEntry[] = [];
  const diagRows: Array<{
    baseModelId: string;
    leadingSegment: string | null;
    providerHit: boolean;
    modelHit: boolean;
    bucket: "bundled" | "byok" | "plus" | "dropped";
  }> = [];
  for (const entry of entries) {
    const seg = leadingSegment(entry.baseModelId);
    const providerHit = !!(seg && providerRegistry.get(seg));
    const suffix = seg ? entry.baseModelId.slice(seg.length + 1) : "";
    const modelHit = !!(seg && providerHit && suffix && modelRegistry.get(seg, suffix));
    let bucket: "bundled" | "byok" | "plus" | "dropped";
    if (seg === COPILOT_PLUS_SEGMENT) {
      plus.push(entry);
      bucket = "plus";
    } else if (providerHit) {
      if (modelHit) {
        byok.push(entry);
        bucket = "byok";
      } else {
        // BYOK provider, but not a model the user picked → drop entirely
        // (OpenCode's bundled snapshot for this provider; unusable without
        // an explicit BYOK pick).
        bucket = "dropped";
      }
    } else {
      bundled.push(entry);
      bucket = "bundled";
    }
    if (BYOK_DIAG) {
      diagRows.push({
        baseModelId: entry.baseModelId,
        leadingSegment: seg,
        providerHit,
        modelHit,
        bucket,
      });
    }
  }
  if (BYOK_DIAG) {
    logInfo("[BYOK-DIAG] classifyOpencodeModels", {
      total: entries.length,
      counts: {
        bundled: bundled.length,
        byok: byok.length,
        plus: plus.length,
        dropped: diagRows.filter((r) => r.bucket === "dropped").length,
      },
      rows: diagRows,
    });
  }
  return { bundled, byok, plus };
}

/**
 * Filter an OpenCode `ModelEntry` list down to the rows we consider
 * "bundled". Thin wrapper over `classifyOpencodeModels` kept for the
 * existing `listBundledModels` consumer + test harness.
 */
export function filterBundledEntries(
  entries: ModelEntry[],
  providerRegistry: ProviderRegistryLike,
  modelRegistry: ModelRegistryLike
): BundledModel[] {
  return classifyOpencodeModels(entries, providerRegistry, modelRegistry).bundled.map((entry) => ({
    id: entry.baseModelId,
    displayName: entry.name,
    provider: leadingSegment(entry.baseModelId) ?? undefined,
  }));
}

/**
 * Read the OpenCode-bundled models the running binary has advertised.
 *
 * Returns `null` (rather than an empty array) when the cached state is
 * missing — that signals "OpenCode not installed / not running" to the
 * panel, which then renders the empty-state copy. An empty array means
 * "OpenCode probed successfully but reports zero non-BYOK rows" — distinct
 * from the not-installed case.
 *
 * Async only to match the spec's signature; in practice this is a sync
 * read of the cached state.
 */
export async function listBundledModels(
  sessionManager: AgentSessionManager | null | undefined,
  providerRegistry: ProviderRegistryLike,
  modelRegistry: ModelRegistryLike
): Promise<BundledModel[] | null> {
  if (!sessionManager) return null;
  const state: BackendState | null = sessionManager.getCachedBackendState("opencode");
  if (!state?.model) return null;
  return filterBundledEntries(state.model.availableModels, providerRegistry, modelRegistry);
}

/**
 * Read the full bucket breakdown the OpenCode panel renders. Same fallback
 * semantics as `listBundledModels`: `null` means "not probed yet / not
 * installed"; a fully-populated buckets value means the probe responded.
 */
export async function listOpencodeBuckets(
  sessionManager: AgentSessionManager | null | undefined,
  providerRegistry: ProviderRegistryLike,
  modelRegistry: ModelRegistryLike
): Promise<OpencodeModelBuckets | null> {
  if (!sessionManager) return null;
  const state: BackendState | null = sessionManager.getCachedBackendState("opencode");
  if (!state?.model) return null;
  return classifyOpencodeModels(state.model.availableModels, providerRegistry, modelRegistry);
}

/** Extract the leading `<provider>` segment of a wire-form model id. */
function leadingSegment(modelId: string): string | null {
  if (!modelId) return null;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  return modelId.slice(0, slash);
}
