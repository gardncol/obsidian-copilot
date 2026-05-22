/**
 * plusModels — surface Copilot Plus hosted models for the OpenCode picker.
 *
 * Per M8 of the Model Management redesign (designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §5.4.1):
 * source #2 of the OpenCode panel's three-source picker is the list of
 * Plus-hosted models (e.g. Copilot Plus Flash). These flow through OpenCode
 * via the brevilabs glue provider that `OpencodeBackend` registers when the
 * user is on a Plus plan; the panel just needs the labels to render.
 *
 * Current implementation: hard-coded stub list, gated by `isPlusEnabled()`.
 *
 *   TODO(M9+): once brevilabs ships a `/plus/models` endpoint, replace the
 *   stub with a `BrevilabsClient.listPlusModels()` call (cached for the
 *   lifetime of a session). Until then, hard-coding the known Plus model
 *   keeps the bridge testable without requiring network access.
 *
 * No live JSON-RPC; this is a pure read of plugin state.
 */
import { ChatModels } from "@/constants";
import { isPlusEnabled } from "@/plusUtils";

/**
 * One Plus-hosted model row, shaped for the panel's `BackendModelPickerRow`
 * consumers. `id` is the modelId-form key (without the `copilot-plus:`
 * prefix); the panel composes the full key when writing overrides.
 */
export interface PlusModel {
  /** Stable model id used as the row's persistence key. */
  id: string;
  /** Human-readable label (e.g. "Copilot Plus Flash"). */
  displayName: string;
  /** Catalog-declared context window when known. */
  contextWindow?: number;
}

/**
 * Hard-coded Plus model catalog. Mirrors the `COPILOT_PLUS_FLASH` constant
 * already wired into `OpencodeBackend.buildOpencodeConfig` — both reach the
 * brevilabs proxy under the same model id.
 *
 * Exported so the OpenCode spawn-time config can register these models under
 * `provider["copilot-plus"].models.<id> = {}`, making them visible in
 * `availableModels` without depending on the legacy `activeModels` pathway
 * (which BYOK has retired). Once brevilabs ships a `/plus/models` endpoint,
 * this constant becomes the offline fallback.
 */
export const PLUS_MODELS: PlusModel[] = [
  { id: ChatModels.COPILOT_PLUS_FLASH, displayName: "Copilot Plus Flash" },
];

/**
 * Read the Plus-hosted models available to the current user.
 *
 *   - Returns `[]` when the user is not on a Plus plan (the panel hides the
 *     Plus section in that case).
 *   - Returns the hard-coded list otherwise. Same shape as
 *     `listBundledModels`, so the panel can render the two side-by-side
 *     with identical row components.
 *
 * Async only to match the spec's signature; this is a pure read today.
 */
export async function listPlusModels(): Promise<PlusModel[]> {
  if (!isPlusEnabled()) return [];
  // Slice so callers can't mutate the canonical list.
  return PLUS_MODELS.slice();
}
