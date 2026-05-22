/**
 * v0 → v2 migration.
 *
 * Translates legacy `CopilotSettings` (~25 top-level provider key fields +
 * `activeModels` carrying chat-model state + per-model overrides) into the
 * v2 shape: `providers` map + `registry` array + per-backend
 * `modelEnabledOverrides` + Quick Chat default.
 *
 * Runs synchronously during `sanitizeSettings` — must never `await`. Registry
 * entries are constructed from v0 data alone; no catalog lookup happens here.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §4.2.
 *
 * **Step 8a — default chat model:**
 * The legacy `defaultModelKey: string` (format `<modelName>|<provider>`) is
 * parsed and resolved against the freshly-populated `settings.registry`. On
 * a match, `settings.defaultModelRef = { providerId, modelId }` is written
 * and `defaultModelKey` is deleted; on no match, the ref is cleared (null).
 *
 * **Step 10 — legacy field deletion (M9):**
 * After synthesizing the new `providers` / `registry` shape, the migration
 * physically removes every legacy provider-key / extras field from the saved
 * settings object. `ChatModelManager`, `embeddingManager`, and the adapter
 * layer now read credentials from `settings.providers[id].apiKeyRef` and
 * `settings.providers[id].extra`, so the legacy fields are no longer load-
 * bearing. The breadcrumb's `droppedFields` records every field deleted so a
 * user-visible toast can list what was removed.
 *
 * NOTE: `activeModels` (chat half) is intentionally NOT deleted here. The
 * registry mirrors it for credential / enablement state, but `activeModels`
 * still carries embedding model entries and per-model runtime data
 * (`baseUrl`, `apiKey`, `enableCors`, `capabilities`, `dimensions`, …) that
 * the chat path consumes via `CustomModel`. A future task will collapse the
 * remaining slice into `RegistryEntry` + adapter overrides.
 *
 * **M2 deviation — keychain (step 9):**
 * Always migrates API keys as `apiKeyRef: { kind: "inline", value: key }`.
 * Moving keys into the new `provider-<id>-apiKey` keychain namespace cannot
 * happen here because `runMigrations` is sync. Instead, the
 * "Post-migration inline-secret → new-namespace keychain promotion" block in
 * `src/services/settingsPersistence.ts` (`loadSettingsWithKeychain`) walks
 * `settings.providers` immediately after this migration returns and, for
 * keychain-only vaults with an available keychain, writes each inline
 * `apiKeyRef.value` into the new namespace and rewrites the ref to
 * `{ kind: "keychain", id }` before the load returns.
 */
import type {
  KeychainRef,
  ProviderConfig,
  ProviderId,
  RegistryEntry,
} from "@/modelManagement/types";

/**
 * Per-model override fields dropped by step 5 — surfaced in the toast.
 *
 * Fields routed into `RegistryEntry.extra` by step 4 are NOT listed here
 * (see `extractEntryExtra` below). Specifically: `enableCors`, `numCtx`,
 * `useResponsesApi`, `enablePromptCaching` are preserved when they have a
 * destination adapter, so they no longer appear as dropped.
 */
const DROPPED_PER_MODEL_OVERRIDE_FIELDS = [
  "temperature",
  "maxTokens",
  "topP",
  "frequencyPenalty",
  "reasoningEffort",
  "verbosity",
  "stream",
  "streamUsage",
  "capabilities",
] as const;

/**
 * Top-level legacy provider-key fields removed by step 10. After migration
 * every API key + provider extras lives under `settings.providers[id]`.
 *
 * `defaultModelKey` is handled separately by step 8a — it's parsed into the
 * structured `defaultModelRef` shape that the registry-backed
 * `modelKeyAtom` reads, then deleted from the saved settings object.
 */
/**
 * NOTE: a copy of this list lives in `src/services/settingsPersistence.ts`
 * (`LEGACY_PROVIDER_KEY_FIELDS_LOCAL`) so the persistence layer can pre-hydrate
 * these fields from the keychain BEFORE running `sanitizeSettings` on a
 * keychain-only vault that still needs the v0→v2 migration. Keep the two
 * lists in sync — duplication is intentional to avoid pulling the whole
 * model-management module into the settings-load critical path.
 */
const LEGACY_PROVIDER_KEY_FIELDS = [
  "openAIApiKey",
  "openAIOrgId",
  "openAIProxyBaseUrl",
  "openAIEmbeddingProxyBaseUrl",
  "anthropicApiKey",
  "googleApiKey",
  "cohereApiKey",
  "mistralApiKey",
  "deepseekApiKey",
  "groqApiKey",
  "xaiApiKey",
  "openRouterAiApiKey",
  "siliconflowApiKey",
  "amazonBedrockApiKey",
  "amazonBedrockRegion",
  "huggingfaceApiKey",
  "azureOpenAIApiKey",
  "azureOpenAIApiInstanceName",
  "azureOpenAIApiDeploymentName",
  "azureOpenAIApiVersion",
  "azureOpenAIApiEmbeddingDeploymentName",
] as const;

/**
 * Maps the legacy `ChatModelProviders` enum string values to the canonical
 * `models.dev` provider ids used by `ProviderRegistry`.
 *
 * Built-in models reference these via `model.provider`. Custom-typed
 * `OPENAI_FORMAT` / `OLLAMA` / `LM_STUDIO` entries are handled separately
 * via the custom-provider grouping (step 3).
 */
const LEGACY_PROVIDER_TO_ID: Record<string, ProviderId> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  "amazon-bedrock": "amazon-bedrock",
  "azure openai": "azure",
  groq: "groq",
  ollama: "ollama",
  "lm-studio": "lmstudio",
  openrouterai: "openrouter",
  mistralai: "mistral",
  deepseek: "deepseek",
  cohereai: "cohere",
  siliconflow: "siliconflow",
  "github-copilot": "github-copilot",
  "3rd party (openai-format)": "openai-compatible",
};

/**
 * Providers whose models are bundled by the OpenCode binary itself.
 * Promoted to a first-class `kind: "system"` provider in `settings.providers`
 * so the `RegistryEntry.providerId` FK invariant holds; the OpenCode backend
 * still consumes them via `modelEnabledOverrides` for now.
 */
const OPENCODE_BUNDLED_PROVIDER = "opencode";
/**
 * Providers/models that are Copilot-Plus hosted, not BYOK. Same promotion
 * story as `opencode` above — first-class `kind: "system"` provider in
 * `settings.providers`, plus the legacy override write for backward compat.
 */
const COPILOT_PLUS_PROVIDER = "copilot-plus";

/** Human-readable display names for the two system providers. */
const SYSTEM_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  [OPENCODE_BUNDLED_PROVIDER]: "OpenCode",
  [COPILOT_PLUS_PROVIDER]: "Copilot Plus",
};

/**
 * Map a `ProviderConfig.type` from a legacy provider name. Used when
 * synthesizing custom providers (no canonical models.dev id exists).
 */
function inferProviderType(legacyProvider: string): ProviderConfig["type"] {
  switch (legacyProvider) {
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "azure openai":
      return "azure";
    case "amazon-bedrock":
      return "bedrock";
    case "github-copilot":
      return "github-copilot";
    default:
      return "openai-compatible";
  }
}

/**
 * Normalize a legacy `modelEnabledOverrides` key into the shape the runtime
 * picker reads. Returns `null` when the key can't be resolved (orphan).
 *
 *   - `quickChat` keeps the `<providerId>:<modelId>` form (multi-provider
 *     backend; the bare modelId would collide across providers).
 *   - All other backends use the bare wire-form `baseModelId`:
 *     · `<modelName>|<provider>` legacy form → look up the providerId, then
 *       construct the wire form `<providerId>/<modelName>` (opencode) or
 *       just `<modelName>` (single-provider backends like claude / codex).
 *     · `<sourcePrefix>:<rest>` panel form → strip the prefix to recover
 *       the wire-form. The two well-known panel prefixes are `opencode:`
 *       (bundled, already wire-form remainder) and `copilot-plus:` (Plus,
 *       prepend `copilot-plus/`). For `<byokProviderId>:<modelId>` panel
 *       writes (e.g. `anthropic:claude-sonnet-4-5`), convert the colon to
 *       a slash so the runtime sees `anthropic/claude-sonnet-4-5`.
 *     · Anything else (bare modelIds already in wire-form) is kept as-is.
 */
function normalizeOverrideKey(
  legacyKey: string,
  backendId: string,
  providers: Record<ProviderId, ProviderConfig>,
  customGroups: Map<string, { providerId: ProviderId; models: Array<{ name?: unknown }> }>
): string | null {
  // Quick Chat: keep `<providerId>:<modelId>` form (no transformation).
  if (backendId === "quickChat") {
    if (legacyKey.includes("|")) {
      const [modelName, legacyProvider] = legacyKey.split("|");
      const mappedId = LEGACY_PROVIDER_TO_ID[legacyProvider];
      if (mappedId && providers[mappedId]) return `${mappedId}:${modelName}`;
      const matchingGroup = [...customGroups.values()].find((g) =>
        g.models.some((m) => m.name === modelName)
      );
      if (matchingGroup) return `${matchingGroup.providerId}:${modelName}`;
      return null;
    }
    return legacyKey;
  }

  // Legacy `<modelName>|<provider>` form.
  if (legacyKey.includes("|")) {
    const [modelName, legacyProvider] = legacyKey.split("|");
    if (!modelName) return null;
    // For opencode we need the wire form `<providerId>/<modelName>`; for
    // claude / codex it's just the bare model name.
    if (backendId === "opencode") {
      const mappedId = LEGACY_PROVIDER_TO_ID[legacyProvider];
      if (mappedId && providers[mappedId]) return `${mappedId}/${modelName}`;
      const matchingGroup = [...customGroups.values()].find((g) =>
        g.models.some((m) => m.name === modelName)
      );
      if (matchingGroup) return `${matchingGroup.providerId}/${modelName}`;
      return null;
    }
    // Claude / Codex are single-provider; the modelName is the wire form.
    return modelName;
  }

  // Panel-prefixed forms (opencode-only — the legacy panel never used
  // these for claude / codex).
  if (backendId === "opencode") {
    if (legacyKey.startsWith("opencode:")) return legacyKey.slice("opencode:".length);
    if (legacyKey.startsWith("copilot-plus:")) {
      return `copilot-plus/${legacyKey.slice("copilot-plus:".length)}`;
    }
    // `<byokProviderId>:<modelId>` — find the longest matching provider id
    // prefix (custom ids contain a colon, so `startsWith` alone is ambiguous).
    let bestMatch: string | null = null;
    for (const provId of Object.keys(providers)) {
      if (legacyKey.startsWith(`${provId}:`)) {
        if (bestMatch === null || provId.length > bestMatch.length) bestMatch = provId;
      }
    }
    if (bestMatch !== null) {
      return `${bestMatch}/${legacyKey.slice(bestMatch.length + 1)}`;
    }
    // Already bare (or shape we don't recognize) — keep as-is.
    return legacyKey;
  }

  // Claude / Codex: strip the `<backendId>:` panel prefix if present.
  if (legacyKey.startsWith(`${backendId}:`)) {
    return legacyKey.slice(backendId.length + 1);
  }
  return legacyKey;
}

/**
 * UUID generator — uses `window.crypto.randomUUID()` when available; falls
 * back to an RFC4122-shaped string otherwise. The fallback path is only
 * hit by very old jsdom runtimes; production (Electron renderer + Obsidian
 * mobile WebView) always has `randomUUID`.
 */
function uuid(): string {
  if (typeof window !== "undefined") {
    const cryptoApi = (window as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof cryptoApi?.randomUUID === "function") {
      return cryptoApi.randomUUID();
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Helpers ------------------------------------------------------------- */

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toInlineKeychainRef(value: string): KeychainRef {
  return { kind: "inline", value };
}

/** Pretty-name a custom provider derived from a base URL. */
function deriveCustomDisplayName(baseUrl: string | undefined, fallback: string): string {
  if (!baseUrl) return fallback;
  try {
    const url = new URL(baseUrl);
    return `${fallback} (${url.host})`;
  } catch {
    return fallback;
  }
}

/** Custom model entry: any `activeModels` row keyed by base URL + api key. */
interface CustomGroup {
  providerId: ProviderId;
  config: ProviderConfig;
  models: Array<Record<string, unknown>>;
}

/**
 * Collect per-model runtime fields off a legacy `CustomModel` into the
 * shape `RegistryEntry.extra` carries. Routed by the legacy provider id so
 * preservation matches the field's canonical adapter — e.g. an Ollama
 * model carries `numCtx`, an OpenRouter model carries `enablePromptCaching`.
 *
 * The migration intentionally writes these keys onto every entry that
 * originates from the matching legacy provider, even when the entry's
 * resolved adapter (driven by `ProviderConfig.type`) does not currently
 * read them. Adapters read individual fields off `entry.extra` by name,
 * so unknown-to-them keys pass through harmlessly while the data stays
 * preserved for future cleanup tasks.
 *
 * Returns `undefined` when no relevant fields are present (so we don't
 * spray empty `extra: {}` blobs across the registry).
 */
function extractEntryExtra(
  m: Record<string, unknown>,
  legacyProvider: string
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};

  // Custom / per-model `baseUrl` override (overrides the provider-level
  // `baseUrl`). Applies to OpenAI-compatible custom endpoints — Ollama,
  // LM Studio, OpenRouter, OPENAI_FORMAT all flow through this path.
  const baseUrl = nonEmptyString(m.baseUrl);
  if (baseUrl) extra.baseUrl = baseUrl;

  // `enableCors`: route through Obsidian's `requestUrl` to bypass renderer
  // CORS restrictions. Common to all openai-compatible-shaped adapters.
  if (typeof m.enableCors === "boolean") extra.enableCors = m.enableCors;

  // Ollama-specific: context window length.
  if (legacyProvider === "ollama" && typeof m.numCtx === "number") {
    extra.numCtx = m.numCtx;
  }

  // LM Studio-specific: Responses API opt-out.
  if (legacyProvider === "lm-studio" && typeof m.useResponsesApi === "boolean") {
    extra.useResponsesApi = m.useResponsesApi;
  }

  // OpenRouter-specific: prompt caching toggle.
  if (legacyProvider === "openrouterai" && typeof m.enablePromptCaching === "boolean") {
    extra.enablePromptCaching = m.enablePromptCaching;
  }

  // Bedrock-specific: AWS region override.
  if (legacyProvider === "amazon-bedrock") {
    const region = nonEmptyString(m.bedrockRegion);
    if (region) extra.bedrockRegion = region;
  }

  // Azure-specific: per-model deployment/instance/version overrides.
  // Rename keys to drop the `azureOpenAIApi` prefix to match the adapter's
  // `entryExtraSchema` (azureInstanceName / azureDeploymentName /
  // azureApiVersion).
  if (legacyProvider === "azure openai") {
    const instance = nonEmptyString(m.azureOpenAIApiInstanceName);
    const deployment = nonEmptyString(m.azureOpenAIApiDeploymentName);
    const version = nonEmptyString(m.azureOpenAIApiVersion);
    if (instance) extra.azureInstanceName = instance;
    if (deployment) extra.azureDeploymentName = deployment;
    if (version) extra.azureApiVersion = version;
  }

  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Top-level migration entry point. Mutates a deep clone of `raw` and returns
 * the new shape plus the list of dropped field-paths for forensics.
 *
 * Idempotent: callers gate this with `settingsVersion >= 2`.
 */
export function migrateV0toV2(raw: Record<string, unknown>): {
  settings: Record<string, unknown>;
  droppedFields: string[];
} {
  // Work on the incoming object directly — `runMigrations` already deep-cloned.
  const settings = raw;
  const droppedFields: string[] = [];

  // Step 1: initialize new shape.
  const providers: Record<ProviderId, ProviderConfig> = {};
  const registry: RegistryEntry[] = [];
  settings.providers = providers;
  settings.registry = registry;
  if (!Array.isArray(settings._migrationBreadcrumbs)) {
    settings._migrationBreadcrumbs = [];
  }

  // Step 2: synthesize ProviderConfig for each non-empty legacy key field.
  const now = Date.now();

  const addBuiltinProvider = (
    id: ProviderId,
    type: ProviderConfig["type"],
    displayName: string,
    apiKey: string,
    extra?: Record<string, unknown>,
    baseUrl?: string
  ) => {
    providers[id] = {
      id,
      kind: "builtin",
      displayName,
      type,
      ...(baseUrl ? { baseUrl } : {}),
      apiKeyRef: toInlineKeychainRef(apiKey),
      ...(extra && Object.keys(extra).length > 0 ? { extra } : {}),
      addedAt: now,
    };
  };

  const openAIKey = nonEmptyString(settings.openAIApiKey);
  if (openAIKey) {
    const extra: Record<string, unknown> = {};
    const orgId = nonEmptyString(settings.openAIOrgId);
    if (orgId) extra.openAIOrgId = orgId;
    const baseUrl = nonEmptyString(settings.openAIProxyBaseUrl);
    addBuiltinProvider("openai", "openai-compatible", "OpenAI", openAIKey, extra, baseUrl);
  }

  const anthropicKey = nonEmptyString(settings.anthropicApiKey);
  if (anthropicKey) {
    addBuiltinProvider("anthropic", "anthropic", "Anthropic", anthropicKey);
  }

  const googleKey = nonEmptyString(settings.googleApiKey);
  if (googleKey) {
    addBuiltinProvider("google", "google", "Google", googleKey);
  }

  const cohereKey = nonEmptyString(settings.cohereApiKey);
  if (cohereKey) {
    addBuiltinProvider("cohere", "openai-compatible", "Cohere", cohereKey);
  }

  const mistralKey = nonEmptyString(settings.mistralApiKey);
  if (mistralKey) {
    addBuiltinProvider("mistral", "openai-compatible", "Mistral", mistralKey);
  }

  const deepseekKey = nonEmptyString(settings.deepseekApiKey);
  if (deepseekKey) {
    addBuiltinProvider("deepseek", "openai-compatible", "DeepSeek", deepseekKey);
  }

  const groqKey = nonEmptyString(settings.groqApiKey);
  if (groqKey) {
    addBuiltinProvider("groq", "openai-compatible", "Groq", groqKey);
  }

  const xaiKey = nonEmptyString(settings.xaiApiKey);
  if (xaiKey) {
    addBuiltinProvider("xai", "openai-compatible", "xAI", xaiKey);
  }

  const orKey = nonEmptyString(settings.openRouterAiApiKey);
  if (orKey) {
    addBuiltinProvider("openrouter", "openai-compatible", "OpenRouter", orKey);
  }

  const siliconKey = nonEmptyString(settings.siliconflowApiKey);
  if (siliconKey) {
    addBuiltinProvider("siliconflow", "openai-compatible", "SiliconFlow", siliconKey);
  }

  const bedrockKey = nonEmptyString(settings.amazonBedrockApiKey);
  if (bedrockKey) {
    const region = nonEmptyString(settings.amazonBedrockRegion);
    addBuiltinProvider(
      "amazon-bedrock",
      "bedrock",
      "Amazon Bedrock",
      bedrockKey,
      region ? { bedrockRegion: region } : {}
    );
  }

  const azureKey = nonEmptyString(settings.azureOpenAIApiKey);
  if (azureKey) {
    const extra: Record<string, unknown> = {};
    const azInstance = nonEmptyString(settings.azureOpenAIApiInstanceName);
    const azDeploy = nonEmptyString(settings.azureOpenAIApiDeploymentName);
    const azVersion = nonEmptyString(settings.azureOpenAIApiVersion);
    if (azInstance) extra.azureInstanceName = azInstance;
    if (azDeploy) extra.azureDeploymentName = azDeploy;
    if (azVersion) extra.azureApiVersion = azVersion;
    addBuiltinProvider("azure", "azure", "Azure OpenAI", azureKey, extra);
  }

  // huggingfaceApiKey: dropped (not in allowlist).
  if (nonEmptyString(settings.huggingfaceApiKey)) {
    droppedFields.push("huggingfaceApiKey");
  }

  // Step 3: custom-provider grouping from `activeModels`.
  const activeModels = Array.isArray(settings.activeModels)
    ? (settings.activeModels as Array<Record<string, unknown>>)
    : [];

  // Group custom entries by `{baseUrl, apiKey, provider}` tuple. Each tuple
  // becomes one custom ProviderConfig.
  const customGroups = new Map<string, CustomGroup>();
  for (const m of activeModels) {
    if (m.isEmbeddingModel === true) continue;
    if (m.isBuiltIn === true) continue;
    // Custom-format entries usually have a baseUrl; group by it + provider + apiKey.
    const baseUrl = nonEmptyString(m.baseUrl);
    const apiKey = nonEmptyString(m.apiKey) ?? "";
    const legacyProvider = typeof m.provider === "string" ? m.provider : "";
    // Skip OpenCode/Plus entries — they migrate to overrides in step 4.
    if (legacyProvider === OPENCODE_BUNDLED_PROVIDER) continue;
    if (legacyProvider === COPILOT_PLUS_PROVIDER) continue;
    // Skip entries that map to a built-in provider id AND we already have a
    // built-in ProviderConfig for them — they aren't custom.
    const mappedBuiltinId = LEGACY_PROVIDER_TO_ID[legacyProvider];
    if (mappedBuiltinId && providers[mappedBuiltinId] && !baseUrl) continue;

    if (!baseUrl) {
      // No baseUrl + no matching built-in key → can't migrate; drop.
      continue;
    }

    const groupKey = `${legacyProvider}|${baseUrl}|${apiKey}`;
    if (!customGroups.has(groupKey)) {
      const customId: ProviderId = `custom:${uuid()}`;
      const displayName = deriveCustomDisplayName(baseUrl, legacyProvider || "Custom");
      const type = inferProviderType(legacyProvider);
      const customConfig: ProviderConfig = {
        id: customId,
        kind: "custom",
        displayName,
        type,
        baseUrl,
        apiKeyRef: apiKey ? toInlineKeychainRef(apiKey) : null,
        addedAt: now,
      };
      providers[customId] = customConfig;
      customGroups.set(groupKey, {
        providerId: customId,
        config: customConfig,
        models: [],
      });
    }
    customGroups.get(groupKey)!.models.push(m);
  }

  // Step 4: activeModels (chat half) → registry. Plus collect OpenCode/Plus
  // overrides and forward them to agentMode.backends.opencode.modelEnabledOverrides.
  const openCodeOverrides: Record<string, boolean> = {};

  /**
   * Idempotently create a `kind: "system"` provider in `settings.providers`
   * for the OpenCode-bundled or Copilot-Plus pseudo-provider. System
   * providers carry no `apiKeyRef` and no `extras` — credentials come from
   * the agent backend itself.
   */
  const ensureSystemProvider = (id: ProviderId): void => {
    if (providers[id]) return;
    providers[id] = {
      id,
      kind: "system",
      displayName: SYSTEM_PROVIDER_DISPLAY_NAMES[id] ?? id,
      addedAt: now,
    };
  };

  for (const m of activeModels) {
    if (m.isEmbeddingModel === true) continue;
    // Skip explicitly disabled entries.
    if (m.enabled === false) {
      const skippedName = typeof m.name === "string" ? m.name : "<unnamed>";
      droppedFields.push(`activeModels[${skippedName}].enabled=false`);
      continue;
    }

    const legacyProvider = typeof m.provider === "string" ? m.provider : "";
    const modelId = typeof m.name === "string" ? m.name : "";
    if (!modelId) continue;

    // OpenCode-bundled / Copilot-Plus entries: promote the pseudo-provider to
    // a first-class `kind: "system"` provider AND create a real registry
    // entry referencing it (the FK invariant — every RegistryEntry.providerId
    // must exist in settings.providers). We *also* keep the legacy
    // `modelEnabledOverrides` write because the OpenCode backend still reads
    // from it — cleanup is a later milestone.
    //
    // Override keys are the bare wire-form `baseModelId` opencode reports
    // (matches what the runtime picker looks up). For Plus, the wire form is
    // always `copilot-plus/<modelId>`. For bundled, `modelId` was already the
    // wire form when the legacy panel wrote it (e.g. `bigpickle/big-pickle`),
    // so we forward it as-is.
    if (legacyProvider === OPENCODE_BUNDLED_PROVIDER) {
      ensureSystemProvider(OPENCODE_BUNDLED_PROVIDER);
      const entryExtra = extractEntryExtra(m, legacyProvider);
      registry.push({
        providerId: OPENCODE_BUNDLED_PROVIDER,
        modelId,
        displayName: nonEmptyString(m.displayName) ?? modelId,
        addedAt: now,
        ...(entryExtra ? { extra: entryExtra } : {}),
      });
      openCodeOverrides[modelId] = true;
      continue;
    }
    if (legacyProvider === COPILOT_PLUS_PROVIDER) {
      ensureSystemProvider(COPILOT_PLUS_PROVIDER);
      const entryExtra = extractEntryExtra(m, legacyProvider);
      registry.push({
        providerId: COPILOT_PLUS_PROVIDER,
        modelId,
        displayName: nonEmptyString(m.displayName) ?? modelId,
        addedAt: now,
        ...(entryExtra ? { extra: entryExtra } : {}),
      });
      openCodeOverrides[`copilot-plus/${modelId}`] = true;
      continue;
    }

    // Built-in entries: drop if no matching ProviderConfig (user never had the key).
    if (m.isBuiltIn === true) {
      const mappedId = LEGACY_PROVIDER_TO_ID[legacyProvider];
      if (!mappedId || !providers[mappedId]) {
        droppedFields.push(`activeModels[${modelId}].isBuiltIn-no-key`);
        continue;
      }
      const entryExtra = extractEntryExtra(m, legacyProvider);
      registry.push({
        providerId: mappedId,
        modelId,
        displayName: nonEmptyString(m.displayName) ?? modelId,
        addedAt: now,
        ...(entryExtra ? { extra: entryExtra } : {}),
      });
      continue;
    }

    // Custom entries: find the group, register one entry per model.
    const baseUrl = nonEmptyString(m.baseUrl);
    const apiKey = nonEmptyString(m.apiKey) ?? "";
    const groupKey = `${legacyProvider}|${baseUrl ?? ""}|${apiKey}`;
    const group = customGroups.get(groupKey);
    if (group) {
      const entryExtra = extractEntryExtra(m, legacyProvider);
      registry.push({
        providerId: group.providerId,
        modelId,
        displayName: nonEmptyString(m.displayName) ?? modelId,
        addedAt: now,
        ...(entryExtra ? { extra: entryExtra } : {}),
      });
      continue;
    }

    // Fallback: non-built-in entry with a matching built-in provider key
    // (e.g. user added a custom Claude model under their Anthropic key).
    const mappedId = LEGACY_PROVIDER_TO_ID[legacyProvider];
    if (mappedId && providers[mappedId]) {
      const entryExtra = extractEntryExtra(m, legacyProvider);
      registry.push({
        providerId: mappedId,
        modelId,
        displayName: nonEmptyString(m.displayName) ?? modelId,
        addedAt: now,
        ...(entryExtra ? { extra: entryExtra } : {}),
      });
      continue;
    }

    // Else: orphan — no provider, no group. Drop with breadcrumb.
    droppedFields.push(`activeModels[${modelId}].orphan-no-provider`);
  }

  // Step 5: per-model override drops are already implicit (we never copied
  // those fields into RegistryEntry). Record them in the breadcrumb so the
  // toast can list the categories of removed settings.
  for (const m of activeModels) {
    if (m.isEmbeddingModel === true) continue;
    for (const field of DROPPED_PER_MODEL_OVERRIDE_FIELDS) {
      if (m[field] !== undefined) {
        const name = typeof m.name === "string" ? m.name : "<unnamed>";
        droppedFields.push(`activeModels[${name}].${field}`);
      }
    }
  }

  // Step 6: normalize agentMode.backends.<id>.modelEnabledOverrides to the
  // shape the runtime picker reads.
  //
  //   - For runtime-wired backends (opencode / claude / codex) the key is
  //     the bare wire-form `baseModelId` opencode/claude/codex reports.
  //     OpenCode wire-form ids carry a provider segment (`anthropic/claude-…`),
  //     so two providers with the same modelId never collide. Claude /
  //     Codex are single-provider backends; their `baseModelId` is the bare
  //     model name (`claude-sonnet-4-5`, `gpt-5`).
  //   - Quick Chat keeps the `<providerId>:<modelId>` form because it routes
  //     through multiple BYOK providers in one backend slice, and the bare
  //     `modelId` alone would collide across providers.
  const agentMode = (settings.agentMode ?? {}) as Record<string, unknown>;
  const backends = (agentMode.backends ?? {}) as Record<string, unknown>;
  for (const backendId of Object.keys(backends)) {
    const backend = backends[backendId] as Record<string, unknown> | undefined;
    if (!backend) continue;
    const overrides = backend.modelEnabledOverrides as Record<string, boolean> | undefined;
    if (!overrides || typeof overrides !== "object") continue;
    const rekeyed: Record<string, boolean> = {};
    for (const [legacyKey, value] of Object.entries(overrides)) {
      if (typeof value !== "boolean") continue;
      const normalized = normalizeOverrideKey(legacyKey, backendId, providers, customGroups);
      if (normalized === null) {
        droppedFields.push(
          `agentMode.backends.${backendId}.modelEnabledOverrides[${legacyKey}].orphan`
        );
        continue;
      }
      rekeyed[normalized] = value;
    }
    backend.modelEnabledOverrides = rekeyed;
  }

  // For OpenCode backend specifically: merge forwarded overrides from step 4.
  if (Object.keys(openCodeOverrides).length > 0) {
    const oc = (backends.opencode ?? {}) as Record<string, unknown>;
    const existing = (oc.modelEnabledOverrides ?? {}) as Record<string, boolean>;
    oc.modelEnabledOverrides = { ...existing, ...openCodeOverrides };
    backends.opencode = oc;
  }

  // Step 7: ensure a quickChat slot exists in `agentMode.backends`.
  // (Per-backend default model was removed; new sessions inherit the
  // most-recently-used selection from `AgentSessionManager.getLastSelection`,
  // falling back to the catalog default.)
  backends.quickChat = {
    modelEnabledOverrides: {},
  };

  // Persist agentMode mutations back.
  agentMode.backends = backends;
  // Step 8: agentMode.enabled — per spec "Desktop is always agent-capable".
  // We don't remove the field (interface keeps it deprecated; consumers
  // treat-as-true on desktop). Migration sets it to true defensively.
  agentMode.enabled = true;
  settings.agentMode = agentMode;

  // Step 8a: migrate the legacy `defaultModelKey` string into the structured
  // `defaultModelRef` shape. The legacy format is `<modelName>|<provider>`;
  // model names may themselves contain pipes (rare but possible — some
  // upstream catalog ids do), so we split on the LAST `|`. After parsing,
  // verify the resulting `(providerId, modelId)` resolves to an entry we
  // just placed in `settings.registry`. On miss, write `null` so the
  // resolver falls back to the first enabled registry entry on next read.
  const legacyDefaultModelKey =
    typeof settings.defaultModelKey === "string" ? settings.defaultModelKey : "";
  let defaultModelRef: { providerId: ProviderId; modelId: string } | null = null;
  if (legacyDefaultModelKey.length > 0) {
    const sepIndex = legacyDefaultModelKey.lastIndexOf("|");
    if (sepIndex > 0 && sepIndex < legacyDefaultModelKey.length - 1) {
      const modelName = legacyDefaultModelKey.slice(0, sepIndex);
      const legacyProvider = legacyDefaultModelKey.slice(sepIndex + 1);
      // Built-in / known-provider path: look up through `LEGACY_PROVIDER_TO_ID`.
      const mappedId = LEGACY_PROVIDER_TO_ID[legacyProvider];
      const candidates: ProviderId[] = [];
      if (mappedId) candidates.push(mappedId);
      // System-provider passthroughs (opencode-bundled, copilot-plus) stay
      // as-is; the legacy provider string already equals the canonical id.
      if (legacyProvider === OPENCODE_BUNDLED_PROVIDER) candidates.push(OPENCODE_BUNDLED_PROVIDER);
      if (legacyProvider === COPILOT_PLUS_PROVIDER) candidates.push(COPILOT_PLUS_PROVIDER);
      for (const candidate of candidates) {
        const match = registry.find((e) => e.providerId === candidate && e.modelId === modelName);
        if (match) {
          defaultModelRef = { providerId: candidate, modelId: modelName };
          break;
        }
      }
      // Last-chance fallback: custom providers — find any registry entry
      // whose modelId matches (custom provider ids are uuid-shaped, the
      // legacy `provider` was a free-form label so we can't map it
      // deterministically).
      if (!defaultModelRef) {
        const match = registry.find((e) => e.modelId === modelName);
        if (match) {
          defaultModelRef = { providerId: match.providerId, modelId: modelName };
        }
      }
    }
  }
  settings.defaultModelRef = defaultModelRef;
  if (settings.defaultModelKey !== undefined) {
    if (legacyDefaultModelKey.length > 0) {
      droppedFields.push("settings.defaultModelKey.deleted");
    }
    delete settings.defaultModelKey;
  }

  // Step 9: keychain promotion — DEFERRED (see file header). All apiKeyRefs
  // are inline at this point.

  // Step 10: physically delete legacy provider-key fields from the saved
  // settings object now that `providers` / `registry` are populated. Records
  // each deleted-with-value field in the breadcrumb so the migration toast
  // can list what was removed and so a future restoration tool can offer to
  // re-prompt the user.
  for (const f of LEGACY_PROVIDER_KEY_FIELDS) {
    const raw = settings[f];
    if (raw !== undefined) {
      const hadValue = typeof raw === "string" ? raw.length > 0 : true;
      if (hadValue) {
        droppedFields.push(`settings.${f}.deleted`);
      }
      delete settings[f];
    }
  }

  return { settings, droppedFields };
}
