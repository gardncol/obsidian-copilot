/**
 * Tests for `ModelRegistry.getDefault` / `setDefault` and the
 * `modelKeyAtom` translation between the structured `defaultModelRef`
 * storage shape and the legacy `<modelId>|<providerId>` wire string.
 */
import { ModelRegistry } from "@/modelManagement/registry/ModelRegistry";
import type { RegistryEntry } from "@/modelManagement/types";
import { getSettings, setSettings, settingsAtom, settingsStore } from "@/settings/model";
import { DEFAULT_SETTINGS } from "@/constants";
import { getModelKey } from "@/aiParams";

describe("ModelRegistry default-model API", () => {
  beforeEach(() => {
    // Reset settings to a clean baseline before each test so atom/registry
    // state doesn't leak between cases.
    settingsStore.set(settingsAtom, { ...DEFAULT_SETTINGS });
    ModelRegistry.resetInstanceForTests();
  });

  function seedRegistry(entries: RegistryEntry[]): void {
    setSettings({ registry: entries });
  }

  it("getDefault: returns the entry matching settings.defaultModelRef", () => {
    const entry: RegistryEntry = {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      addedAt: 1,
    };
    seedRegistry([
      {
        providerId: "openai",
        modelId: "gpt-5",
        displayName: "GPT-5",
        addedAt: 0,
      },
      entry,
    ]);
    setSettings({
      defaultModelRef: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    const result = ModelRegistry.getInstance().getDefault();
    expect(result).toEqual(entry);
  });

  it("getDefault: stale ref (provider/model deleted) → first registry entry", () => {
    const first: RegistryEntry = {
      providerId: "openai",
      modelId: "gpt-5",
      displayName: "GPT-5",
      addedAt: 0,
    };
    seedRegistry([first]);
    setSettings({
      // Pointing at a provider/model that doesn't exist any more.
      defaultModelRef: { providerId: "anthropic", modelId: "removed-model" },
    });
    expect(ModelRegistry.getInstance().getDefault()).toEqual(first);
  });

  it("getDefault: no ref + non-empty registry → first entry", () => {
    const first: RegistryEntry = {
      providerId: "openai",
      modelId: "gpt-5",
      displayName: "GPT-5",
      addedAt: 0,
    };
    seedRegistry([first]);
    setSettings({ defaultModelRef: null });
    expect(ModelRegistry.getInstance().getDefault()).toEqual(first);
  });

  it("getDefault: empty registry → undefined", () => {
    seedRegistry([]);
    setSettings({ defaultModelRef: null });
    expect(ModelRegistry.getInstance().getDefault()).toBeUndefined();
  });

  it("setDefault: writes settings.defaultModelRef", async () => {
    await ModelRegistry.getInstance().setDefault({
      providerId: "openai",
      modelId: "gpt-5",
    });
    expect(getSettings().defaultModelRef).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
    });
  });

  it("setDefault(null): clears settings.defaultModelRef", async () => {
    setSettings({
      defaultModelRef: { providerId: "openai", modelId: "gpt-5" },
    });
    await ModelRegistry.getInstance().setDefault(null);
    expect(getSettings().defaultModelRef).toBeNull();
  });
});

describe("modelKeyAtom — defaultModelRef → legacy wire string", () => {
  beforeEach(() => {
    settingsStore.set(settingsAtom, { ...DEFAULT_SETTINGS });
  });

  it("returns `<modelId>|<providerId>` when defaultModelRef is set", () => {
    setSettings({
      defaultModelRef: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    expect(getModelKey()).toBe("claude-sonnet-4-5|anthropic");
  });

  it("returns empty string when defaultModelRef is null", () => {
    setSettings({ defaultModelRef: null });
    expect(getModelKey()).toBe("");
  });
});
