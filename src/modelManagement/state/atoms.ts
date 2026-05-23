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
 * `backends`) are not yet typed fields on `CopilotSettings` — the
 * settings-wiring follow-up PR adds them. Until then, the local
 * helper below reads them with fallbacks so the atoms compile and
 * downstream UI components can bind to them today.
 */

import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

import { settingsAtom, type CopilotSettings } from "@/settings/model";

import type {
  BackendConfig,
  BackendType,
  ConfiguredModel,
  Provider,
  ProviderOrigin,
} from "@/modelManagement/types/persisted";
import type { EnabledBackendEntry } from "@/modelManagement/types/runtime";

// Stable empty fallbacks. Allocated once so Jotai's `===` short-circuit
// holds when the underlying slices are absent (pre-settings-wiring) or
// unchanged between settings writes — otherwise every settings write
// would invalidate every derived picker atom.
const EMPTY_PROVIDERS: Readonly<Record<string, Provider>> = Object.freeze({});
const EMPTY_CONFIGURED_MODELS: readonly ConfiguredModel[] = Object.freeze([]);
const EMPTY_BACKENDS: Readonly<Partial<Record<BackendType, BackendConfig>>> = Object.freeze({});

/**
 * Reads the three persisted slices with fallbacks. Pre-settings-wiring,
 * `CopilotSettings` doesn't declare these fields, so we widen via the
 * type intersection below — the cast is intentional and isolated to
 * this one helper.
 */
function readSlices(settings: CopilotSettings): {
  providers: Readonly<Record<string, Provider>>;
  configuredModels: readonly ConfiguredModel[];
  backends: Readonly<Partial<Record<BackendType, BackendConfig>>>;
} {
  const widened = settings as CopilotSettings & {
    providers?: Record<string, Provider>;
    configuredModels?: ConfiguredModel[];
    backends?: Partial<Record<BackendType, BackendConfig>>;
  };
  return {
    providers: widened.providers ?? EMPTY_PROVIDERS,
    configuredModels: widened.configuredModels ?? EMPTY_CONFIGURED_MODELS,
    backends: widened.backends ?? EMPTY_BACKENDS,
  };
}

// -----------------------------------------------------------------------------
// Raw slice atoms — derived directly from settings.
// -----------------------------------------------------------------------------

export const providersAtom = atom<Readonly<Record<string, Provider>>>(
  (get) => readSlices(get(settingsAtom)).providers
);

export const configuredModelsAtom = atom<readonly ConfiguredModel[]>(
  (get) => readSlices(get(settingsAtom)).configuredModels
);

export const backendsAtom = atom<Readonly<Partial<Record<BackendType, BackendConfig>>>>(
  (get) => readSlices(get(settingsAtom)).backends
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
