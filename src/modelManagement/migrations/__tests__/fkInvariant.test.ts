/**
 * Foreign-key invariant tests for the model management module.
 *
 * Asserts that for every `RegistryEntry` in `settings.registry`, the referenced
 * `settings.providers[entry.providerId]` exists. This is the contract
 * documented on `RegistryEntry.providerId` in `@/modelManagement/types`.
 *
 * Historically the v0→v2 migration violated this invariant by forwarding
 * `opencode:*` and `copilot-plus:*` registry entries to
 * `agentMode.backends.opencode.modelEnabledOverrides` instead of writing them
 * to `settings.providers` — those pseudo-providers had no home in the
 * providers map. They're now promoted to first-class `kind: "system"`
 * providers (see `ProviderConfig.kind` JSDoc).
 */
import { runModelManagementMigrations } from "@/modelManagement/migrations/runMigrations";
import type { ProviderConfig, RegistryEntry } from "@/modelManagement/types";

/**
 * Assert the FK invariant: every registry entry references a provider that
 * exists in `settings.providers`.
 */
function assertProviderFkInvariant(settings: Record<string, unknown>): void {
  const providers = settings.providers as Record<string, ProviderConfig> | undefined;
  const registry = settings.registry as RegistryEntry[] | undefined;
  expect(providers).toBeDefined();
  expect(registry).toBeDefined();
  for (const entry of registry ?? []) {
    expect(providers).toHaveProperty(entry.providerId);
    expect(providers?.[entry.providerId]?.id).toBe(entry.providerId);
  }
}

describe("ProviderId FK invariant: every RegistryEntry.providerId exists in settings.providers", () => {
  it("holds on a fresh empty install", () => {
    const { settings } = runModelManagementMigrations({
      agentMode: { enabled: true, backends: {} },
    });
    assertProviderFkInvariant(settings);
  });

  it("holds for a single OpenAI BYOK provider with one model", () => {
    const { settings } = runModelManagementMigrations({
      openAIApiKey: "sk-test",
      activeModels: [{ name: "gpt-5", provider: "openai", isBuiltIn: true, enabled: true }],
      agentMode: { enabled: true, backends: {} },
    });
    assertProviderFkInvariant(settings);
  });

  it("holds for OpenCode-bundled + Copilot-Plus pseudo-providers (system providers created)", () => {
    // The exact scenario from the task brief: v0 settings carry
    // `opencode:big-pickle` and `copilot-plus:plus-flash` activeModels. The
    // migration must create matching `kind: "system"` providers AND real
    // registry entries pointing at them.
    const { settings } = runModelManagementMigrations({
      activeModels: [
        { name: "big-pickle", provider: "opencode", enabled: true },
        { name: "plus-flash", provider: "copilot-plus", enabled: true },
      ],
      agentMode: { enabled: true, backends: {} },
    });
    const s = settings as Record<string, unknown>;
    assertProviderFkInvariant(s);

    // Spot-check the two specific system providers.
    const providers = s.providers as Record<string, ProviderConfig>;
    expect(providers.opencode).toMatchObject({
      id: "opencode",
      kind: "system",
      displayName: "OpenCode",
    });
    expect(providers["copilot-plus"]).toMatchObject({
      id: "copilot-plus",
      kind: "system",
      displayName: "Copilot Plus",
    });

    // System providers carry no API key.
    expect(providers.opencode.apiKeyRef).toBeUndefined();
    expect(providers["copilot-plus"].apiKeyRef).toBeUndefined();
    expect(providers.opencode.extra).toBeUndefined();
    expect(providers["copilot-plus"].extra).toBeUndefined();

    // Both system providers have at least one registry entry referencing them.
    const registry = s.registry as RegistryEntry[];
    expect(registry.some((e) => e.providerId === "opencode" && e.modelId === "big-pickle")).toBe(
      true
    );
    expect(
      registry.some((e) => e.providerId === "copilot-plus" && e.modelId === "plus-flash")
    ).toBe(true);
  });

  it("idempotently creates ONE system provider for multiple OpenCode models", () => {
    // Two opencode activeModels should share the same `opencode` system
    // provider — not produce two duplicates.
    const { settings } = runModelManagementMigrations({
      activeModels: [
        { name: "big-pickle", provider: "opencode", enabled: true },
        { name: "small-pickle", provider: "opencode", enabled: true },
      ],
      agentMode: { enabled: true, backends: {} },
    });
    const s = settings as Record<string, unknown>;
    assertProviderFkInvariant(s);
    const providers = s.providers as Record<string, ProviderConfig>;
    expect(Object.keys(providers)).toEqual(["opencode"]);
    const registry = s.registry as RegistryEntry[];
    expect(registry).toHaveLength(2);
    for (const entry of registry) expect(entry.providerId).toBe("opencode");
  });

  it("holds for the mixed-everything fixture (built-ins + custom + system)", () => {
    const { settings } = runModelManagementMigrations({
      anthropicApiKey: "sk-ant",
      openAIApiKey: "sk-openai",
      activeModels: [
        {
          name: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          isBuiltIn: true,
          enabled: true,
        },
        { name: "gpt-5", provider: "openai", isBuiltIn: true, enabled: true },
        {
          name: "qwen2.5-coder",
          provider: "ollama",
          isBuiltIn: false,
          enabled: true,
          baseUrl: "http://localhost:11434",
        },
        { name: "big-pickle", provider: "opencode", enabled: true },
        { name: "plus-flash", provider: "copilot-plus", enabled: true },
      ],
      agentMode: { enabled: true, backends: {} },
    });
    const s = settings as Record<string, unknown>;
    assertProviderFkInvariant(s);
    const providers = s.providers as Record<string, ProviderConfig>;
    // Built-in + custom + 2 system = 4 distinct provider ids (plus the
    // custom: uuid for the ollama entry).
    expect(providers.anthropic.kind).toBe("builtin");
    expect(providers.openai.kind).toBe("builtin");
    expect(providers.opencode.kind).toBe("system");
    expect(providers["copilot-plus"].kind).toBe("system");
    const customIds = Object.keys(providers).filter((id) => id.startsWith("custom:"));
    expect(customIds).toHaveLength(1);
    expect(providers[customIds[0]].kind).toBe("custom");
  });
});
