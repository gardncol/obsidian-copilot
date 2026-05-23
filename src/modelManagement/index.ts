// Public surface of the model-management module. Host code must import
// from this barrel — deep imports of `@/modelManagement/types/*` are
// blocked by `no-restricted-imports` patterns in eslint.config.mjs.

export type { CatalogProvider, ModelInfo, ProviderType } from "./types/catalog";
export type {
  AgentType,
  BackendConfig,
  BackendType,
  ConfiguredModel,
  Provider,
  ProviderOrigin,
} from "./types/persisted";
