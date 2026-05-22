/**
 * Public API for the model management module.
 *
 * EVERYTHING outside `src/modelManagement/` must import via this barrel.
 * An ESLint `import/no-restricted-paths` rule (see `eslint.config.mjs`)
 * enforces the boundary. Internal files reference each other via the
 * `@/modelManagement/...` aliased path; only consumers of the module go
 * through `@/modelManagement`.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.0.
 */

export {
  ProviderRegistry,
  getProviderApiKey,
  getProviderApiKeySync,
} from "@/modelManagement/providers/ProviderRegistry";
export { ModelRegistry, type ModelRef } from "@/modelManagement/registry/ModelRegistry";
export { ModelCatalogService } from "@/modelManagement/catalog/ModelCatalogService";
// NOTE: `ChatModelFactory` is deliberately NOT re-exported from this
// barrel. The factory eagerly imports every adapter (each pulling in its
// own LangChain client), which would force tests that only need the
// catalog or registry types to mock the entire LangChain dependency tree.
// `ChatModelManager` consumes the factory + adapter helpers via a
// dedicated ESLint carve-out (see eslint.config.mjs §model-management
// boundary) instead.
export { ByokPanel } from "@/modelManagement/ui/tabs/ByokPanel";
export { AddProviderDialog } from "@/modelManagement/ui/dialogs/AddProviderDialog";
export {
  ConfigureProviderDialog,
  type ConfigureProviderState,
  type ConfigureProviderSavePayload,
} from "@/modelManagement/ui/dialogs/ConfigureProviderDialog";
export { AddCustomModelDialog } from "@/modelManagement/ui/dialogs/AddCustomModelDialog";
export { ProviderCatalogList } from "@/modelManagement/ui/components/ProviderCatalogList";
export {
  runModelManagementMigrations,
  CURRENT_SETTINGS_VERSION,
  type MigrationBreadcrumb,
} from "@/modelManagement/migrations/runMigrations";
export {
  maybeShowMigrationNotice,
  registerMigrationStatusCommand,
} from "@/modelManagement/migrations/migrationNotice";
export { SUPPORTED_PROVIDER_IDS } from "@/modelManagement/providers/supportedProviders";

export type {
  ProviderId,
  ProviderConfig,
  RegistryEntry,
  KeychainRef,
  VerificationResult,
} from "@/modelManagement/types";
