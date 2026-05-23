/**
 * Tests for `BackendConfigRegistry`.
 *
 * Real settings store via `resetSettings`. The provider and configured-
 * model registries are constructed against the same store; no Obsidian
 * APIs are touched.
 */

import { getSettings, resetSettings } from "@/settings/model";

import { ConfiguredModelRegistry } from "@/modelManagement/models/ConfiguredModelRegistry";
import { ProviderRegistry } from "@/modelManagement/providers/ProviderRegistry";
import { ProviderAdapterRegistry } from "@/modelManagement/providers/adapters/ProviderAdapterRegistry";
import type { BackendType } from "@/modelManagement/types/persisted";

import { BackendConfigRegistry } from "./BackendConfigRegistry";

import type { App } from "obsidian";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

const CHAT: BackendType = "chat";
const OPENCODE: BackendType = "opencode";

describe("BackendConfigRegistry", () => {
  let registry: BackendConfigRegistry;
  let models: ConfiguredModelRegistry;
  let providers: ProviderRegistry;

  beforeEach(() => {
    resetSettings();
    const fakeApp = { secretStorage: {}, vault: { adapter: {} } } as unknown as App;
    providers = new ProviderRegistry(fakeApp, new ProviderAdapterRegistry());
    models = new ConfiguredModelRegistry();
    registry = new BackendConfigRegistry(providers, models);
  });

  it("get() returns a stable empty default for untouched backends", () => {
    const a = registry.get(CHAT);
    const b = registry.get(CHAT);
    expect(a).toBe(b);
    expect(a.enabledModels).toEqual([]);
    expect(a.defaultModel).toBeNull();
  });

  it("enableModel() is idempotent", async () => {
    await registry.enableModel(CHAT, "m1");
    await registry.enableModel(CHAT, "m1");
    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
  });

  it("enableModel() appends in order", async () => {
    await registry.enableModel(CHAT, "m1");
    await registry.enableModel(CHAT, "m2");
    await registry.enableModel(CHAT, "m3");
    expect(registry.get(CHAT).enabledModels).toEqual(["m1", "m2", "m3"]);
  });

  it("disableModel() is idempotent and clears default if it was the removed id", async () => {
    await registry.setEnabledModels(CHAT, ["m1", "m2"]);
    await registry.setDefaultModel(CHAT, "m2");
    await registry.disableModel(CHAT, "m2");
    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
    expect(registry.get(CHAT).defaultModel).toBeNull();
    // Idempotent.
    await registry.disableModel(CHAT, "m2");
    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
  });

  it("setEnabledModels() drops the default when it leaves the list", async () => {
    await registry.setEnabledModels(CHAT, ["m1", "m2"]);
    await registry.setDefaultModel(CHAT, "m1");
    await registry.setEnabledModels(CHAT, ["m2", "m3"]);
    expect(registry.get(CHAT).defaultModel).toBeNull();
    expect(registry.get(CHAT).enabledModels).toEqual(["m2", "m3"]);
  });

  it("setDefaultModel() throws when the id is not enabled (invariant #4)", async () => {
    await registry.setEnabledModels(CHAT, ["m1"]);
    await expect(registry.setDefaultModel(CHAT, "m2")).rejects.toThrow(/invariant/);
    expect(registry.get(CHAT).defaultModel).toBeNull();
  });

  it("setDefaultModel(null) clears regardless of enabled list", async () => {
    await registry.setEnabledModels(CHAT, ["m1"]);
    await registry.setDefaultModel(CHAT, "m1");
    await registry.setDefaultModel(CHAT, null);
    expect(registry.get(CHAT).defaultModel).toBeNull();
  });

  it("setDefaultModel(null) on an untouched backend is a no-op (no spurious row)", async () => {
    const before = getSettings().backends;
    await registry.setDefaultModel(CHAT, null);
    // The backends slice must not have gained an empty entry.
    expect(getSettings().backends).toBe(before);
    expect(getSettings().backends[CHAT]).toBeUndefined();
  });

  it("removeRefs() sweeps every backend and nulls matching defaults", async () => {
    await registry.setEnabledModels(CHAT, ["m1", "m2", "m3"]);
    await registry.setDefaultModel(CHAT, "m2");
    await registry.setEnabledModels(OPENCODE, ["m2", "m4"]);
    await registry.setDefaultModel(OPENCODE, "m4");

    await registry.removeRefs(["m2", "m3"]);

    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
    expect(registry.get(CHAT).defaultModel).toBeNull(); // m2 was the default
    expect(registry.get(OPENCODE).enabledModels).toEqual(["m4"]);
    expect(registry.get(OPENCODE).defaultModel).toBe("m4"); // untouched
  });

  it("removeRefs() with empty input is a no-op", async () => {
    await registry.setEnabledModels(CHAT, ["m1"]);
    const before = getSettings().backends;
    await registry.removeRefs([]);
    expect(getSettings().backends).toBe(before);
  });

  it("resolveEnabled() returns ok entries when refs exist, broken otherwise", async () => {
    const providerId = await providers.add({
      providerType: "anthropic",
      displayName: "Anthropic",
      origin: { kind: "byok" },
    });
    const okId = await models.add({
      providerId,
      info: { id: "claude-sonnet-4-5", displayName: "Claude" },
    });
    await registry.setEnabledModels(CHAT, [okId, "missing-id"]);

    const resolved = registry.resolveEnabled(CHAT);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].state).toBe("ok");
    expect(resolved[1].state).toBe("broken");
  });
});
