import {
  ModelCatalogService,
  type CatalogStorageAdapter,
} from "@/modelManagement/catalog/ModelCatalogService";
import type {
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
} from "@/modelManagement/catalog/modelsCatalog.types";

// Mock logger so calls go through without exercising the logFileManager
// singleton (which itself reaches into the global Obsidian `app`).
jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

/**
 * Build a minimal but valid catalog provider for fixture purposes.
 */
function makeProvider(
  id: string,
  models: Array<Partial<CatalogModel> & Pick<CatalogModel, "id" | "name">>
): CatalogProvider {
  return {
    id,
    name: id,
    env: [],
    models: Object.fromEntries(
      models.map((m) => {
        const full: CatalogModel = {
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 0, output: 0 },
          ...m,
        };
        return [m.id, full];
      })
    ),
  };
}

/**
 * In-memory fake of the Obsidian DataAdapter subset we use.
 */
class FakeAdapter implements CatalogStorageAdapter {
  files = new Map<string, string>();
  /** Counts of operations for read-once / write-once assertions. */
  ops = { exists: 0, read: 0, write: 0 };

  async exists(path: string): Promise<boolean> {
    this.ops.exists += 1;
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    this.ops.read += 1;
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`Not found: ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    this.ops.write += 1;
    this.files.set(path, data);
  }
}

// Path strings used only as opaque keys inside the FakeAdapter — the real
// plugin resolves the config directory via Obsidian's API. The lint that
// warns about hard-coded `.obsidian/` does not apply to test fixtures.
// eslint-disable-next-line obsidianmd/hardcoded-config-path
const MANIFEST_DIR = ".obsidian/plugins/copilot";
const CACHE_PATH = `${MANIFEST_DIR}/.modelsCatalogCache.json`;

describe("ModelCatalogService", () => {
  beforeEach(() => {
    ModelCatalogService.resetInstanceForTests();
  });

  describe("ensureLoaded()", () => {
    it("is idempotent — disk is read once across many calls", async () => {
      const adapter = new FakeAdapter();
      const catalog: ModelsCatalog = {
        anthropic: makeProvider("anthropic", [{ id: "claude", name: "Claude" }]),
      };
      adapter.files.set(CACHE_PATH, JSON.stringify({ fetchedAt: 1700000000000, data: catalog }));
      const fetchImpl = jest.fn();
      const svc = new ModelCatalogService({ fetchImpl });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      await svc.ensureLoaded();
      await svc.ensureLoaded();
      await svc.ensureLoaded();

      // Disk read should happen exactly once.
      expect(adapter.ops.read).toBe(1);
      // ensureLoaded must never hit the network on its own.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(svc.getMeta().source).toBe("disk");
      expect(svc.getMeta().fetchedAt).toBe(1700000000000);
    });

    it("never fetches the network until refresh() is called", async () => {
      const adapter = new FakeAdapter();
      const fetchImpl = jest.fn();
      const svc = new ModelCatalogService({ fetchImpl });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      await svc.ensureLoaded();
      svc.getProvider("anthropic");
      svc.getAllProviders();
      svc.getMeta();
      svc.searchModels("anthropic", "");

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("leaves the catalog empty when disk read fails", async () => {
      const adapter: CatalogStorageAdapter = {
        exists: jest.fn().mockResolvedValue(true),
        // Throw on read to simulate I/O failure.
        read: jest.fn().mockRejectedValue(new Error("disk corrupt")),
        write: jest.fn(),
      };
      const svc = new ModelCatalogService();
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      await svc.ensureLoaded();

      expect(svc.getMeta().source).toBe("bundled");
      expect(svc.getMeta().fetchedAt).toBeNull();
      // Empty catalog — providers are populated only by a successful refresh().
      expect(svc.getProvider("anthropic")).toBeUndefined();
      expect(svc.getProvider("openai")).toBeUndefined();
    });

    it("leaves the catalog empty when disk cache file is absent", async () => {
      const adapter = new FakeAdapter(); // empty
      const svc = new ModelCatalogService();
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      await svc.ensureLoaded();
      expect(svc.getMeta().source).toBe("bundled");
      expect(svc.getAllProviders()).toEqual([]);
    });

    it("leaves the catalog empty when disk cache JSON is malformed", async () => {
      const adapter = new FakeAdapter();
      adapter.files.set(CACHE_PATH, "{not valid json");
      const svc = new ModelCatalogService();
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      await svc.ensureLoaded();
      expect(svc.getMeta().source).toBe("bundled");
      expect(svc.getAllProviders()).toEqual([]);
    });
  });

  describe("refresh()", () => {
    it("success path: fetch → memory + disk write → change emitted, meta reports 'live'", async () => {
      const adapter = new FakeAdapter();
      const liveCatalog: ModelsCatalog = {
        anthropic: makeProvider("anthropic", [
          { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
        ]),
      };
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => liveCatalog,
      });
      const svc = new ModelCatalogService({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => 1737000000000,
      });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });
      const listener = jest.fn();
      svc.onChange(listener);

      const result = await svc.refresh();

      expect(result.ok).toBe(true);
      expect(result.source).toBe("live");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(svc.getMeta()).toEqual({ fetchedAt: 1737000000000, source: "live" });
      expect(svc.getProvider("anthropic")?.models["claude-sonnet-4-5-20250929"]).toBeDefined();
      // Disk write must have happened.
      expect(adapter.ops.write).toBe(1);
      const persisted: unknown = JSON.parse(adapter.files.get(CACHE_PATH) ?? "{}");
      expect((persisted as { fetchedAt: number }).fetchedAt).toBe(1737000000000);
      // Listener fired exactly once.
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("filters non-supported providers out of the live payload", async () => {
      const adapter = new FakeAdapter();
      const liveCatalog = {
        anthropic: makeProvider("anthropic", [{ id: "claude", name: "Claude" }]),
        togetherai: makeProvider("togetherai", [{ id: "llama", name: "Llama" }]),
        "fireworks-ai": makeProvider("fireworks-ai", [{ id: "x", name: "x" }]),
      };
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => liveCatalog,
      });
      const svc = new ModelCatalogService({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      const result = await svc.refresh();

      expect(result.ok).toBe(true);
      expect(svc.getProvider("anthropic")).toBeDefined();
      expect(svc.getProvider("togetherai")).toBeUndefined();
      expect(svc.getProvider("fireworks-ai")).toBeUndefined();
    });

    it("preserves last loaded source on non-200 response", async () => {
      const adapter = new FakeAdapter();
      // Seed disk cache so ensureLoaded picks it up first.
      const diskCatalog: ModelsCatalog = {
        anthropic: makeProvider("anthropic", [{ id: "claude-from-disk", name: "Claude" }]),
      };
      adapter.files.set(
        CACHE_PATH,
        JSON.stringify({ fetchedAt: 1700000000000, data: diskCatalog })
      );
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({}),
      });
      const svc = new ModelCatalogService({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });
      const listener = jest.fn();
      svc.onChange(listener);

      const result = await svc.refresh();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("503");
      expect(svc.getMeta().source).toBe("disk");
      expect(svc.getProvider("anthropic")?.models["claude-from-disk"]).toBeDefined();
      expect(listener).not.toHaveBeenCalled();
      // Failed fetch never writes disk.
      expect(adapter.ops.write).toBe(0);
    });

    it("preserves last loaded source when fetch throws (network error / timeout)", async () => {
      const adapter = new FakeAdapter();
      const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
      const svc = new ModelCatalogService({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });

      const result = await svc.refresh();

      expect(result.ok).toBe(false);
      expect(result.error).toBe("network down");
      // ensureLoaded ran inside refresh() and seeded bundled.
      expect(svc.getMeta().source).toBe("bundled");
    });
  });

  describe("getAllProviders()", () => {
    it("sorts recommended providers (anthropic, openai, google) to the front after refresh()", async () => {
      const adapter = new FakeAdapter();
      const liveCatalog: ModelsCatalog = {
        groq: makeProvider("groq", [{ id: "g1", name: "G1" }]),
        openrouter: makeProvider("openrouter", [{ id: "o1", name: "O1" }]),
        google: makeProvider("google", [{ id: "gem", name: "Gemini" }]),
        openai: makeProvider("openai", [{ id: "gpt", name: "GPT" }]),
        anthropic: makeProvider("anthropic", [{ id: "claude", name: "Claude" }]),
      };
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => liveCatalog,
      });
      const svc = new ModelCatalogService({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      svc.init({ adapter, manifestDir: MANIFEST_DIR });
      await svc.refresh();

      const ids = svc.getAllProviders().map((p) => p.id);
      // Recommended order is fixed regardless of SUPPORTED_PROVIDER_IDS order.
      expect(ids.slice(0, 3)).toEqual(["anthropic", "openai", "google"]);
      // The rest are still present.
      expect(ids).toContain("groq");
      expect(ids).toContain("openrouter");
    });
  });

  describe("searchModels filter behavior", () => {
    const PROVIDER_ID = "test-provider";

    /**
     * Build a service whose memory cache holds exactly one provider with
     * the fixture models we care about for filter testing.
     */
    function buildServiceWith(models: CatalogModel[]): ModelCatalogService {
      const adapter = new FakeAdapter();
      const catalog: ModelsCatalog = {
        [PROVIDER_ID]: {
          id: PROVIDER_ID,
          name: PROVIDER_ID,
          env: [],
          models: Object.fromEntries(models.map((m) => [m.id, m])),
        },
      };
      adapter.files.set(CACHE_PATH, JSON.stringify({ fetchedAt: 1, data: catalog }));
      const svc = new ModelCatalogService({ now: () => 1737000000000 }); // ~Jan 2025
      svc.init({ adapter, manifestDir: MANIFEST_DIR });
      return svc;
    }

    it("contextAtLeast filters out models below threshold", async () => {
      const svc = buildServiceWith([
        {
          id: "small",
          name: "Small",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 4096 },
        },
        {
          id: "big",
          name: "Big",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 4096 },
        },
      ]);
      await svc.ensureLoaded();

      const ids = svc
        .searchModels(PROVIDER_ID, "", { contextAtLeast: 200_000 })
        .map((m) => m.id)
        .sort();
      expect(ids).toEqual(["big"]);
    });

    it("maxCostPerMillion filters out expensive models; drops cost-less models when active", async () => {
      const svc = buildServiceWith([
        {
          id: "cheap",
          name: "Cheap",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1, output: 1 },
          cost: { input: 0.5, output: 0.3 }, // 0.8/M
        },
        {
          id: "pricey",
          name: "Pricey",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1, output: 1 },
          cost: { input: 3, output: 6 }, // 9/M
        },
        {
          id: "unknown-cost",
          name: "Unknown",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1, output: 1 },
        },
      ]);
      await svc.ensureLoaded();

      const ids = svc
        .searchModels(PROVIDER_ID, "", { maxCostPerMillion: 1 })
        .map((m) => m.id)
        .sort();
      expect(ids).toEqual(["cheap"]);
    });

    it("releasedWithinMonths filters by release date; drops date-less models when active", async () => {
      // `now` set to 2025-01-16 (≈1737000000000 ms). 6 months before that
      // is ~2024-07-20; older releases should be filtered out.
      const svc = buildServiceWith([
        {
          id: "old",
          name: "Old",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1, output: 1 },
          release_date: "2023-01-15",
        },
        {
          id: "fresh",
          name: "Fresh",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1, output: 1 },
          release_date: "2024-12-01",
        },
        {
          id: "undated",
          name: "Undated",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1, output: 1 },
        },
      ]);
      await svc.ensureLoaded();

      const ids = svc
        .searchModels(PROVIDER_ID, "", { releasedWithinMonths: 6 })
        .map((m) => m.id)
        .sort();
      expect(ids).toEqual(["fresh"]);
    });

    it("combines filters with AND semantics and applies the query string", async () => {
      const svc = buildServiceWith([
        {
          id: "claude-fresh",
          name: "Claude Fresh",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 4096 },
          release_date: "2024-12-01",
          cost: { input: 0.1, output: 0.2 },
        },
        {
          id: "claude-old",
          name: "Claude Old",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 4096 },
          release_date: "2023-01-01",
          cost: { input: 0.1, output: 0.2 },
        },
        {
          id: "gpt-fresh",
          name: "GPT Fresh",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 4096 },
          release_date: "2024-12-01",
          cost: { input: 0.1, output: 0.2 },
        },
      ]);
      await svc.ensureLoaded();

      const ids = svc
        .searchModels(PROVIDER_ID, "claude", {
          contextAtLeast: 200_000,
          releasedWithinMonths: 6,
        })
        .map((m) => m.id)
        .sort();
      expect(ids).toEqual(["claude-fresh"]);
    });
  });
});
