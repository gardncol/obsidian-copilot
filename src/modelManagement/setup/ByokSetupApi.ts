/**
 * BYOK setup workflow. The user-facing wizard ("Add Provider" → pick
 * catalog or template → enter key → select models → Verify & save)
 * calls into this class. Bundles the "create Provider row + create N
 * ConfiguredModel rows + auto-enroll in default backends" recipe so
 * the wizard doesn't have to know the order or invariants.
 *
 * Two flows:
 *   - `addCatalogProvider`  — user picked a `models.dev` entry.
 *                              Catalog supplies `ModelInfo` snapshots.
 *   - `addTemplateProvider` — user picked a built-in template
 *                              (Ollama, LMStudio, custom OpenAI-compat,
 *                              Azure, Bedrock) and hand-typed model
 *                              ids. Only `id` + `displayName`
 *                              populated on each `ModelInfo`.
 *
 * Both produce identical `Provider` + `ConfiguredModel` shapes; the
 * difference is only in how `ModelInfo` was sourced.
 *
 * Default auto-enrollment is `BYOK_DEFAULT_AUTO_ENROLL`
 * = `["chat", "opencode"]` so BYOK models surface in both Simple
 * Chat and the OpenCode agent picker out of the box.
 */

import type { CatalogProvider, ModelInfo } from "@/modelManagement/types/catalog";
import type { BackendType } from "@/modelManagement/types/persisted";
import type { ProviderTemplate } from "@/modelManagement/types/runtime";
import type { BackendConfigRegistry } from "@/modelManagement/backends/BackendConfigRegistry";
import type { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import type { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";

/**
 * Default set of backends that new BYOK / Plus models are
 * auto-enrolled into. Exported so other origins (Plus, future flows)
 * reuse the same default and the constant is greppable.
 */
export const BYOK_DEFAULT_AUTO_ENROLL: readonly BackendType[] = ["chat", "opencode"];

export interface AddCatalogProviderInput {
  /** From `ModelCatalogService.getProvider(id)`. */
  template: CatalogProvider;
  displayName: string;
  /** Overrides `template.defaultBaseUrl`. */
  baseUrl?: string;
  /** Set for providers that need an API key. Stored in the keychain. */
  apiKey?: string;
  /** Per-providerType payload (Azure deployment, Bedrock region,
   *  OpenAI org id, …). Validated by the adapter's `extrasSchema`
   *  at `ChatModelFactory.build()` time. */
  extras?: Record<string, unknown>;
  /** Subset of `template.models` keys the user checked. */
  selectedWireModelIds: readonly string[];
  /** Defaults to `BYOK_DEFAULT_AUTO_ENROLL`. Pass `[]` to skip
   *  auto-enrollment entirely (user will enable models manually
   *  through Configure Provider). */
  autoEnrollIn?: readonly BackendType[];
}

export interface AddTemplateProviderInput {
  /** From `ModelCatalogService.listBuiltinTemplates()`. */
  template: ProviderTemplate;
  displayName: string;
  baseUrl?: string;
  apiKey?: string;
  extras?: Record<string, unknown>;
  /** User-typed models — `id` is the wire form, `displayName` is
   *  whatever the user labelled it. Other `ModelInfo` fields stay
   *  empty until the user edits the row. */
  selectedModels: readonly Pick<ModelInfo, "id" | "displayName">[];
  autoEnrollIn?: readonly BackendType[];
}

export interface AddModelsInput {
  providerId: string;
  /** Catalog-snapshotted or hand-typed `ModelInfo`s — same shape
   *  either way. */
  models: readonly ModelInfo[];
  autoEnrollIn?: readonly BackendType[];
}

export interface ByokSetupResult {
  providerId: string;
  configuredModelIds: string[];
}

export class ByokSetupApi {
  readonly #providers: ProviderRegistry;
  readonly #models: ConfiguredModelRegistry;
  readonly #backends: BackendConfigRegistry;

  constructor(
    providerRegistry: ProviderRegistry,
    configuredModelRegistry: ConfiguredModelRegistry,
    backendConfigRegistry: BackendConfigRegistry
  ) {
    this.#providers = providerRegistry;
    this.#models = configuredModelRegistry;
    this.#backends = backendConfigRegistry;
  }

  /**
   * Catalog-driven flow. Creates the Provider (with
   * `origin: { kind: "byok" }`), creates N ConfiguredModels from the
   * catalog snapshots, stores the API key in the keychain, and
   * enrolls the new models into `autoEnrollIn ?? BYOK_DEFAULT_AUTO_ENROLL`.
   *
   * Order: provider row → API key → models → backend enrollment. If a
   * later step fails, earlier writes stay in place. The caller is
   * responsible for surfacing the error to the user; cleanup of a
   * partial setup happens through `coordinator.removeProvider`.
   */
  async addCatalogProvider(input: AddCatalogProviderInput): Promise<ByokSetupResult> {
    const providerId = await this.#providers.add({
      providerType: input.template.providerType,
      displayName: input.displayName,
      baseUrl: input.baseUrl ?? input.template.defaultBaseUrl,
      origin: { kind: "byok" },
      extras: input.extras,
    });

    if (input.apiKey) {
      await this.#providers.setApiKey(providerId, input.apiKey);
    }

    const infos = input.selectedWireModelIds
      .map((wireId) => input.template.models[wireId])
      .filter((info): info is NonNullable<typeof info> => info !== undefined);
    const configuredModelIds = await this.#models.bulkSet(providerId, infos);

    const enrollIn = input.autoEnrollIn ?? BYOK_DEFAULT_AUTO_ENROLL;
    for (const backend of enrollIn) {
      for (const id of configuredModelIds) {
        await this.#backends.enableModel(backend, id);
      }
    }

    return { providerId, configuredModelIds };
  }

  /**
   * Template-driven flow. Same shape as catalog flow, but model
   * metadata is whatever the user typed in (no catalog snapshot).
   *
   * TODO(byok): implemented in the template-flow PR. See
   * `designdocs/BYOK_UI_SPEC.md` for the surrounding UI.
   */
  addTemplateProvider(input: AddTemplateProviderInput): Promise<ByokSetupResult> {
    throw new Error("[modelManagement] ByokSetupApi.addTemplateProvider not implemented yet");
  }

  /**
   * Add more configured models to an existing BYOK provider without
   * touching the Provider row. Skips models that already exist on
   * the provider (uniqueness invariant). Returns the resulting
   * `configuredModelId`s in input order.
   *
   * TODO(byok): implemented in the template-flow PR (custom-model
   * add for existing providers).
   */
  addModels(input: AddModelsInput): Promise<string[]> {
    throw new Error("[modelManagement] ByokSetupApi.addModels not implemented yet");
  }
}
