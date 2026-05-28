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

  it("disableModel() is idempotent", async () => {
    await registry.setEnabledModels(CHAT, ["m1", "m2"]);
    await registry.disableModel(CHAT, "m2");
    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
    // Idempotent.
    await registry.disableModel(CHAT, "m2");
    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
  });

  it("removeRefs() sweeps every backend", async () => {
    await registry.setEnabledModels(CHAT, ["m1", "m2", "m3"]);
    await registry.setEnabledModels(OPENCODE, ["m2", "m4"]);

    await registry.removeRefs(["m2", "m3"]);

    expect(registry.get(CHAT).enabledModels).toEqual(["m1"]);
    expect(registry.get(OPENCODE).enabledModels).toEqual(["m4"]);
  });

  it("removeRefs() with empty input is a no-op", async () => {
    await registry.setEnabledModels(CHAT, ["m1"]);
    const before = getSettings().backends;
    await registry.removeRefs([]);
    expect(getSettings().backends).toBe(before);
  });

  describe("subscribe()", () => {
    it("fires on enable/disable/setEnabledModels/removeRefs that actually mutate", async () => {
      const listener = jest.fn();
      const unsubscribe = registry.subscribe(listener);

      await registry.enableModel(CHAT, "m1");
      expect(listener).toHaveBeenCalledTimes(1);

      // Idempotent enable: no settings change, no emit.
      await registry.enableModel(CHAT, "m1");
      expect(listener).toHaveBeenCalledTimes(1);

      await registry.setEnabledModels(CHAT, ["m1", "m2"]);
      expect(listener).toHaveBeenCalledTimes(2);

      await registry.disableModel(CHAT, "m2");
      expect(listener).toHaveBeenCalledTimes(3);

      // Idempotent disable on an absent id: no change, no emit.
      await registry.disableModel(CHAT, "m99");
      expect(listener).toHaveBeenCalledTimes(3);

      await registry.removeRefs(["m1"]);
      expect(listener).toHaveBeenCalledTimes(4);

      // Empty / no-match removeRefs: no change, no emit.
      await registry.removeRefs([]);
      await registry.removeRefs(["missing-id"]);
      expect(listener).toHaveBeenCalledTimes(4);

      unsubscribe();
      await registry.enableModel(OPENCODE, "x");
      expect(listener).toHaveBeenCalledTimes(4);
    });

    it("setEnabledModels() with the same ordered ids is a no-op (no emit, no slice rotation)", async () => {
      await registry.setEnabledModels(CHAT, ["m1", "m2"]);
      const listener = jest.fn();
      registry.subscribe(listener);
      const before = getSettings().backends;

      await registry.setEnabledModels(CHAT, ["m1", "m2"]);

      expect(listener).not.toHaveBeenCalled();
      expect(getSettings().backends).toBe(before);
    });

    it("setEnabledModels() with reordered ids is NOT a no-op (positional list)", async () => {
      await registry.setEnabledModels(CHAT, ["m1", "m2"]);
      const listener = jest.fn();
      registry.subscribe(listener);

      await registry.setEnabledModels(CHAT, ["m2", "m1"]);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(registry.get(CHAT).enabledModels).toEqual(["m2", "m1"]);
    });
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
