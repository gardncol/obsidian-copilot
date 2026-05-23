/**
 * Reactive read layer for model management. Single source of
 * reactivity for the whole module — registries no longer carry
 * `onChange` APIs; subscribers (React or otherwise) attach to these
 * atoms instead.
 *
 * Derived from the existing `settingsAtom` so any settings write
 * fans out automatically through Jotai. React components use
 * `useAtomValue(<atom>, { store: settingsStore })`; non-React
 * subscribers use `settingsStore.sub(<atom>, listener)`.
 *
 * The three persisted slices (`providers`, `configuredModels`,
 * `backends`) live directly on `CopilotSettings` and are backfilled
 * with frozen empties by `sanitizeSettings` on load — so derived atoms
 * never observe a fresh `{}` / `[]` and Jotai's `===` short-circuit
 * holds across reads. See AGENTS.md → "Referential stability".
 */

import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

import { settingsAtom } from "@/settings/model";

import type {
  BackendConfig,
  BackendType,
  ConfiguredModel,
  Provider,
  ProviderOrigin,
} from "@/modelManagement/types/persisted";
import type { EnabledBackendEntry } from "@/modelManagement/types/runtime";

// -----------------------------------------------------------------------------
// Raw slice atoms — derived directly from settings.
// -----------------------------------------------------------------------------

export const providersAtom = atom<Readonly<Record<string, Provider>>>(
  (get) => get(settingsAtom).providers
);

export const configuredModelsAtom = atom<readonly ConfiguredModel[]>(
  (get) => get(settingsAtom).configuredModels
);

export const backendsAtom = atom<Readonly<Partial<Record<BackendType, BackendConfig>>>>(
  (get) => get(settingsAtom).backends
);

// -----------------------------------------------------------------------------
// Common filtered views.
// -----------------------------------------------------------------------------

function filterByOrigin(
  providers: Readonly<Record<string, Provider>>,
  kind: ProviderOrigin["kind"]
): readonly Provider[] {
  return Object.values(providers).filter((p) => p.origin.kind === kind);
}

/** All providers with `origin.kind === "byok"`. Used by the BYOK
 *  settings tab. */
export const byokProvidersAtom = atom<readonly Provider[]>((get) =>
  filterByOrigin(get(providersAtom), "byok")
);

/** All providers with `origin.kind === "agent"`. Used by the agent
 *  setup panels (each panel filters further by `origin.agentType`). */
export const agentProvidersAtom = atom<readonly Provider[]>((get) =>
  filterByOrigin(get(providersAtom), "agent")
);

/** The (at most one) provider with `origin.kind === "copilot-plus"`. */
export const copilotPlusProvidersAtom = atom<readonly Provider[]>((get) =>
  filterByOrigin(get(providersAtom), "copilot-plus")
);

// -----------------------------------------------------------------------------
// Picker-ready join view per backend.
// -----------------------------------------------------------------------------

/**
 * Resolves a backend's `enabledModels` into picker-ready entries.
 * Order preserved. Broken refs (configured model deleted, provider
 * deleted) surface as `state: "broken"` rather than being silently
 * dropped — see data-model spec invariant #3.
 *
 * Use as: `useAtomValue(backendPickerAtomFamily("chat"), { store: settingsStore })`.
 */
export const backendPickerAtomFamily = atomFamily((backend: BackendType) =>
  atom<readonly EnabledBackendEntry[]>((get) => {
    const config = get(backendsAtom)[backend] ?? { enabledModels: [], defaultModel: null };
    const models = get(configuredModelsAtom);
    const providers = get(providersAtom);
    return config.enabledModels.map<EnabledBackendEntry>((configuredModelId) => {
      const configuredModel = models.find((m) => m.configuredModelId === configuredModelId);
      const provider = configuredModel ? providers[configuredModel.providerId] : undefined;
      if (configuredModel && provider) {
        return { configuredModelId, state: "ok", configuredModel, provider };
      }
      return { configuredModelId, state: "broken" };
    });
  })
);
