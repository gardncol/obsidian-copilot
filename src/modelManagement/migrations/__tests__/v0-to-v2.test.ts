/**
 * v0 → v2 migration tests.
 *
 * Each scenario is structured as: build a minimal raw settings object,
 * run the migration, assert on the resulting shape. Fixtures are inlined
 * for readability — they're small enough that splitting them across files
 * would just add ceremony.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §6 M2 test list.
 */
import {
  CURRENT_SETTINGS_VERSION,
  runModelManagementMigrations,
} from "@/modelManagement/migrations/runMigrations";

describe("v0 → v2 settings migration", () => {
  it("1. fresh install (empty settings) → empty new shape + quickChat skeleton", () => {
    const raw = { agentMode: { enabled: true, backends: {} } };
    const { settings, migrationsApplied } = runModelManagementMigrations(raw);
    expect(migrationsApplied).toEqual([2]);
    const s = settings as Record<string, unknown>;
    expect(s.settingsVersion).toBe(2);
    expect(s.providers).toEqual({});
    expect(s.registry).toEqual([]);
    const agentMode = s.agentMode as Record<string, unknown>;
    const backends = agentMode.backends as Record<string, unknown>;
    expect(backends.quickChat).toEqual({ modelEnabledOverrides: {} });
  });

  it("2. only OpenAI key, no activeModels → one provider, no registry entries", () => {
    const raw = {
      openAIApiKey: "sk-test-123",
      openAIOrgId: "org-foo",
      activeModels: [],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const providers = s.providers as Record<
      string,
      { id: string; apiKeyRef: unknown; extra?: Record<string, unknown> }
    >;
    expect(Object.keys(providers)).toEqual(["openai"]);
    expect(providers.openai.id).toBe("openai");
    expect(providers.openai.apiKeyRef).toEqual({ kind: "inline", value: "sk-test-123" });
    expect(providers.openai.extra).toEqual({ openAIOrgId: "org-foo" });
    expect(s.registry).toEqual([]);
  });

  it("3. activeModels with built-ins but no keys → all dropped", () => {
    const raw = {
      activeModels: [
        { name: "gpt-5", provider: "openai", isBuiltIn: true, enabled: true },
        {
          name: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.providers).toEqual({});
    expect(s.registry).toEqual([]);
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    const dropped = crumbs[0].droppedFields ?? [];
    expect(dropped.some((f) => f.includes("gpt-5"))).toBe(true);
    expect(dropped.some((f) => f.includes("claude-sonnet-4-5"))).toBe(true);
  });

  it("4. OpenAI key + multi-provider built-ins → only OpenAI built-ins migrate", () => {
    const raw = {
      openAIApiKey: "sk-test",
      activeModels: [
        { name: "gpt-5", provider: "openai", isBuiltIn: true, enabled: true },
        {
          name: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
        { name: "gemini-2.5-flash", provider: "google", isBuiltIn: true, enabled: true },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const providers = s.providers as Record<string, unknown>;
    expect(Object.keys(providers)).toEqual(["openai"]);
    const registry = s.registry as Array<{ providerId: string; modelId: string }>;
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ providerId: "openai", modelId: "gpt-5" });
  });

  it("5. mixed built-in + custom + Ollama → split correctly", () => {
    const raw = {
      anthropicApiKey: "sk-ant-test",
      activeModels: [
        {
          name: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
        {
          name: "llama3.2",
          provider: "ollama",
          isBuiltIn: false,
          enabled: true,
          baseUrl: "http://localhost:11434",
        },
        {
          name: "qwen2.5-coder",
          provider: "ollama",
          isBuiltIn: false,
          enabled: true,
          baseUrl: "http://localhost:11434",
        },
        {
          name: "text-embedding-3-large",
          provider: "openai",
          isEmbeddingModel: true,
          enabled: true,
        },
      ],
      activeEmbeddingModels: [
        { name: "text-embedding-3-large", provider: "openai", enabled: true },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const providers = s.providers as Record<string, { kind: string }>;
    expect(providers.anthropic.kind).toBe("builtin");
    // Custom provider for Ollama should exist with a custom: id.
    const customIds = Object.keys(providers).filter((id) => id.startsWith("custom:"));
    expect(customIds).toHaveLength(1);
    expect(providers[customIds[0]].kind).toBe("custom");

    const registry = s.registry as Array<{ providerId: string; modelId: string }>;
    expect(registry).toHaveLength(3); // anthropic + 2 ollama, no embedding
    // Embedding-model list untouched.
    const aem = s.activeEmbeddingModels as Array<{ name: string }>;
    expect(aem).toHaveLength(1);
    expect(aem[0].name).toBe("text-embedding-3-large");
  });

  it("6. per-model overrides → dropped + recorded in breadcrumbs", () => {
    const raw = {
      openAIApiKey: "sk-test",
      activeModels: [
        {
          name: "gpt-5",
          provider: "openai",
          isBuiltIn: true,
          enabled: true,
          temperature: 0.7,
          maxTokens: 4096,
          reasoningEffort: "high",
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    const dropped = crumbs[0].droppedFields ?? [];
    expect(dropped.some((f) => f.includes("temperature"))).toBe(true);
    expect(dropped.some((f) => f.includes("maxTokens"))).toBe(true);
    expect(dropped.some((f) => f.includes("reasoningEffort"))).toBe(true);
  });

  it("7. activeModels[*].enabled === false → dropped", () => {
    const raw = {
      openAIApiKey: "sk-test",
      activeModels: [
        { name: "gpt-5", provider: "openai", isBuiltIn: true, enabled: true },
        { name: "gpt-4.1", provider: "openai", isBuiltIn: true, enabled: false },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const registry = s.registry as Array<{ modelId: string }>;
    expect(registry.map((e) => e.modelId)).toEqual(["gpt-5"]);
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    const dropped = crumbs[0].droppedFields ?? [];
    expect(dropped.some((f) => f.includes("gpt-4.1") && f.includes("enabled=false"))).toBe(true);
  });

  it("8. modelEnabledOverrides re-keyed to bare wire-form baseModelId (opencode = <providerId>/<modelName>)", () => {
    const raw = {
      anthropicApiKey: "sk-ant-test",
      activeModels: [
        {
          name: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
      ],
      agentMode: {
        enabled: true,
        backends: {
          opencode: {
            modelEnabledOverrides: {
              "claude-sonnet-4-5-20250929|anthropic": true,
              "ghost-model|nowhere": false,
            },
          },
        },
      },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const agentMode = s.agentMode as Record<string, unknown>;
    const backends = agentMode.backends as Record<
      string,
      { modelEnabledOverrides: Record<string, boolean> }
    >;
    const overrides = backends.opencode.modelEnabledOverrides;
    expect(overrides["anthropic/claude-sonnet-4-5-20250929"]).toBe(true);
    // orphan dropped
    expect(overrides["ghost-model|nowhere"]).toBeUndefined();
    expect(overrides["ghost-model"]).toBeUndefined();
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    expect((crumbs[0].droppedFields ?? []).some((f) => f.includes("ghost-model"))).toBe(true);
  });

  it("10. corrupt/empty input → falls back gracefully", () => {
    expect(runModelManagementMigrations(null).migrationsApplied).toEqual([]);
    expect(runModelManagementMigrations(undefined).migrationsApplied).toEqual([]);
    // An empty-ish object still runs to completion.
    const result = runModelManagementMigrations({});
    expect(result.migrationsApplied).toEqual([2]);
    const s = result.settings as Record<string, unknown>;
    expect(s.settingsVersion).toBe(2);
    expect(s.providers).toEqual({});
    expect(s.registry).toEqual([]);
  });

  it("11. idempotency: running migration twice produces the same output", () => {
    const raw = {
      anthropicApiKey: "sk-ant-test",
      activeModels: [
        {
          name: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const first = runModelManagementMigrations(raw);
    const second = runModelManagementMigrations(first.settings);
    expect(second.migrationsApplied).toEqual([]);
    // The settings object is returned unchanged on the second pass.
    expect(second.settings).toBe(first.settings);
  });

  it("12. OpenCode/Plus models produce system providers + registry entries + overrides", () => {
    const raw = {
      activeModels: [
        { name: "big-pickle", provider: "opencode", enabled: true },
        { name: "copilot-plus-flash", provider: "copilot-plus", enabled: true },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    // System providers are now first-class entries in settings.providers.
    const providers = s.providers as Record<
      string,
      { id: string; kind: string; displayName: string; apiKeyRef?: unknown }
    >;
    expect(providers.opencode).toMatchObject({
      id: "opencode",
      kind: "system",
      displayName: "OpenCode",
    });
    expect(providers.opencode.apiKeyRef).toBeUndefined();
    expect(providers["copilot-plus"]).toMatchObject({
      id: "copilot-plus",
      kind: "system",
      displayName: "Copilot Plus",
    });
    expect(providers["copilot-plus"].apiKeyRef).toBeUndefined();
    // Real registry entries reference the system providers — the FK invariant.
    const registry = s.registry as Array<{ providerId: string; modelId: string }>;
    expect(registry).toHaveLength(2);
    expect(registry).toContainEqual(
      expect.objectContaining({ providerId: "opencode", modelId: "big-pickle" })
    );
    expect(registry).toContainEqual(
      expect.objectContaining({ providerId: "copilot-plus", modelId: "copilot-plus-flash" })
    );
    // Legacy override writes preserved — OpenCode backend still reads from them.
    const agentMode = s.agentMode as Record<string, unknown>;
    const backends = agentMode.backends as Record<
      string,
      { modelEnabledOverrides: Record<string, boolean> }
    >;
    expect(backends.opencode.modelEnabledOverrides["big-pickle"]).toBe(true);
    expect(backends.opencode.modelEnabledOverrides["copilot-plus/copilot-plus-flash"]).toBe(true);
  });

  it("breadcrumb records the version transition", () => {
    const raw = { agentMode: { enabled: true, backends: {} } };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const crumbs = s._migrationBreadcrumbs as Array<{
      from: number;
      to: number;
      appliedAt: number;
    }>;
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].from).toBe(0);
    expect(crumbs[0].to).toBe(CURRENT_SETTINGS_VERSION);
    expect(typeof crumbs[0].appliedAt).toBe("number");
  });

  it("Azure with extras migrates correctly", () => {
    const raw = {
      azureOpenAIApiKey: "az-key",
      azureOpenAIApiInstanceName: "mycorp",
      azureOpenAIApiDeploymentName: "gpt-5-deploy",
      azureOpenAIApiVersion: "2024-05-01-preview",
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const providers = s.providers as Record<
      string,
      { type: string; extra?: Record<string, unknown> }
    >;
    expect(providers.azure.type).toBe("azure");
    expect(providers.azure.extra).toMatchObject({
      azureInstanceName: "mycorp",
      azureDeploymentName: "gpt-5-deploy",
      azureApiVersion: "2024-05-01-preview",
    });
  });

  it("Bedrock with region migrates correctly", () => {
    const raw = {
      amazonBedrockApiKey: "aws-key",
      amazonBedrockRegion: "us-west-2",
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    const providers = s.providers as Record<
      string,
      { type: string; extra?: Record<string, unknown> }
    >;
    expect(providers["amazon-bedrock"].type).toBe("bedrock");
    expect(providers["amazon-bedrock"].extra).toEqual({ bedrockRegion: "us-west-2" });
  });

  it("step 10 — deletes every legacy provider-key field from the saved settings", () => {
    const raw = {
      openAIApiKey: "sk-openai",
      openAIOrgId: "org-foo",
      openAIProxyBaseUrl: "https://proxy.example",
      openAIEmbeddingProxyBaseUrl: "https://embed.example",
      anthropicApiKey: "sk-ant",
      googleApiKey: "gk",
      cohereApiKey: "ck",
      mistralApiKey: "mk",
      deepseekApiKey: "dk",
      groqApiKey: "gqk",
      xaiApiKey: "xk",
      openRouterAiApiKey: "ork",
      siliconflowApiKey: "sfk",
      amazonBedrockApiKey: "awsk",
      amazonBedrockRegion: "us-west-2",
      huggingfaceApiKey: "hfk",
      azureOpenAIApiKey: "azk",
      azureOpenAIApiInstanceName: "azinst",
      azureOpenAIApiDeploymentName: "azdep",
      azureOpenAIApiVersion: "2024-05-01-preview",
      azureOpenAIApiEmbeddingDeploymentName: "azembdep",
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    // Every legacy provider-key field must be gone after migration.
    const LEGACY_FIELDS = [
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
    ];
    for (const f of LEGACY_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(s, f)).toBe(false);
    }
    // The values must have been migrated into providers/registry.
    const providers = s.providers as Record<string, { apiKeyRef?: { value?: string } }>;
    expect(providers.openai.apiKeyRef?.value).toBe("sk-openai");
    expect(providers.anthropic.apiKeyRef?.value).toBe("sk-ant");
    expect(providers["amazon-bedrock"].apiKeyRef?.value).toBe("awsk");
    // Breadcrumbs should record which legacy fields carried real values.
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    const dropped = crumbs[0]?.droppedFields ?? [];
    expect(dropped.some((f) => f.includes("openAIApiKey.deleted"))).toBe(true);
    expect(dropped.some((f) => f.includes("huggingfaceApiKey.deleted"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // defaultModelKey → defaultModelRef
  // ---------------------------------------------------------------------------

  it("defaultModelKey → defaultModelRef: built-in provider, matching registry entry", () => {
    const raw = {
      anthropicApiKey: "sk-ant",
      defaultModelKey: "claude-sonnet-4-5|anthropic",
      activeModels: [
        {
          name: "claude-sonnet-4-5",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.defaultModelRef).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(Object.prototype.hasOwnProperty.call(s, "defaultModelKey")).toBe(false);
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    const dropped = crumbs[0]?.droppedFields ?? [];
    expect(dropped).toContain("settings.defaultModelKey.deleted");
  });

  it("defaultModelKey → defaultModelRef: no matching registry entry → null", () => {
    const raw = {
      // Has a key but the activeModels list has nothing matching the
      // legacy `defaultModelKey`, so the ref must be null.
      anthropicApiKey: "sk-ant",
      defaultModelKey: "some-model-the-user-removed|anthropic",
      activeModels: [
        {
          name: "claude-sonnet-4-5",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.defaultModelRef).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(s, "defaultModelKey")).toBe(false);
  });

  it("defaultModelKey empty string → defaultModelRef = null", () => {
    const raw = {
      defaultModelKey: "",
      activeModels: [],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.defaultModelRef).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(s, "defaultModelKey")).toBe(false);
    // Empty legacy value should NOT add a `deleted` breadcrumb entry.
    const crumbs = s._migrationBreadcrumbs as Array<{ droppedFields?: string[] }>;
    const dropped = crumbs[0]?.droppedFields ?? [];
    expect(dropped.some((f) => f === "settings.defaultModelKey.deleted")).toBe(false);
  });

  it("defaultModelKey → defaultModelRef: legacy openrouterai provider string is canonicalized", () => {
    const raw = {
      openRouterAiApiKey: "or-key",
      defaultModelKey: "google/gemini-2.5-flash|openrouterai",
      activeModels: [
        {
          name: "google/gemini-2.5-flash",
          provider: "openrouterai",
          isBuiltIn: true,
          enabled: true,
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.defaultModelRef).toEqual({
      providerId: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
  });

  it("defaultModelKey → defaultModelRef: copilot-plus pseudo-provider passes through", () => {
    const raw = {
      defaultModelKey: "gpt-4o-mini|copilot-plus",
      activeModels: [
        {
          name: "gpt-4o-mini",
          provider: "copilot-plus",
          enabled: true,
        },
      ],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.defaultModelRef).toEqual({
      providerId: "copilot-plus",
      modelId: "gpt-4o-mini",
    });
  });

  it("defaultModelKey → defaultModelRef: missing defaultModelKey → null", () => {
    const raw = {
      anthropicApiKey: "sk-ant",
      activeModels: [],
      agentMode: { enabled: true, backends: {} },
    };
    const { settings } = runModelManagementMigrations(raw);
    const s = settings as Record<string, unknown>;
    expect(s.defaultModelRef).toBeNull();
  });
});
