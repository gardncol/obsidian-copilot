import type {
  CatalogDiskCache,
  CatalogFilters,
  CatalogMeta,
  CatalogModel,
  CatalogProvider,
  CatalogSource,
  ModelsCatalog,
  RefreshResult,
} from "@/modelManagement/catalog/modelsCatalog.types";
import { SUPPORTED_PROVIDER_IDS } from "@/modelManagement/providers/supportedProviders";
import type { ProviderId } from "@/modelManagement/types";
import { logInfo, logWarn } from "@/logger";

/**
 * Where to fetch the live catalog from.
 */
const CATALOG_URL = "https://models.dev/api.json";

/**
 * 5-second cap on the live fetch per §1.4 — we never block the user
 * indefinitely on a remote call.
 */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Recommended providers always appear first in `getAllProviders()`. The
 * remaining providers follow `SUPPORTED_PROVIDER_IDS` order.
 */
const RECOMMENDED_PROVIDER_IDS: readonly string[] = ["anthropic", "openai", "google"];

/**
 * Filesystem abstraction used by the service. Mirrors the subset of
 * Obsidian's `DataAdapter` we touch — pulled out so tests can plug in a
 * tiny fake without bringing in the full Obsidian mock surface.
 */
export interface CatalogStorageAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/**
 * Options consumed by `init()`. Both fields are required before any of the
 * disk-touching paths can run, but accessors that only need in-memory state
 * (and the bundled fallback) work without `init()` having been called.
 */
export interface CatalogServiceInit {
  /**
   * Vault data adapter (typically `app.vault.adapter`). The service only
   * uses `exists` / `read` / `write` — see `CatalogStorageAdapter`.
   */
  adapter: CatalogStorageAdapter;
  /**
   * Plugin manifest `dir` (e.g. `.obsidian/plugins/copilot`). The disk
   * cache file is written under this directory.
   */
  manifestDir: string;
}

/**
 * Optional injection hooks for tests. None of these are exposed via the
 * `@/modelManagement` public API — the service is constructed via
 * `getInstance()` everywhere except inside its own test file.
 */
export interface CatalogServiceOverrides {
  /** Replace `globalThis.fetch` for the duration of the instance. */
  fetchImpl?: typeof fetch;
  /** Override `Date.now()` for deterministic timestamps. */
  now?: () => number;
}

/**
 * Internal name of the disk cache file (kept hidden via leading-dot
 * convention — same pattern Obsidian uses for other plugin caches).
 */
const DISK_CACHE_FILENAME = ".modelsCatalogCache.json";

/**
 * `ModelCatalogService` — lazy, three-tier read facade backing the BYOK
 * model picker.
 *
 * Read order: memory cache → disk cache → bundled fallback.
 * Writes: only `refresh()` mutates state (live fetch → memory + disk).
 *
 * The service is a singleton (`getInstance()`); production code never
 * instantiates it directly. Tests use the constructor with overrides.
 *
 * **Lazy contract**: nothing reads the disk or hits the network until a
 * caller actually invokes `ensureLoaded()` or `refresh()`. Plugin onload
 * MUST NOT call either — only BYOK-tab-side callers (M4+) do.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §1.4.
 */
export class ModelCatalogService {
  private static instance: ModelCatalogService | undefined;

  private adapter: CatalogStorageAdapter | undefined;
  private manifestDir: string | undefined;
  /**
   * Resolved lazily so test environments without a global `fetch` (e.g.
   * the default jsdom in `jest.config.js`) can still construct the
   * service. Production builds run in Electron renderer where
   * `globalThis.fetch` is always defined.
   */
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private memoryCache: ModelsCatalog | undefined;
  private memorySource: CatalogSource = "bundled";
  private fetchedAt: number | null = null;

  /** Tracks whether ensureLoaded has populated the memory cache. */
  private loaded = false;
  /** In-flight ensureLoaded promise for idempotency. */
  private loadInflight: Promise<void> | null = null;

  /** Listeners notified when the memory cache changes. */
  private readonly listeners = new Set<() => void>();

  /**
   * Public constructor used only by tests (and the singleton bootstrap).
   * Application code should use `getInstance()` so all consumers share
   * one cache.
   */
  constructor(overrides: CatalogServiceOverrides = {}) {
    this.fetchImpl =
      overrides.fetchImpl ??
      ((input, init) => {
        // Resolve `fetch` lazily so the constructor works under jsdom (no
        // global fetch), Electron renderer (window.fetch), and any other
        // host. We avoid `globalThis` directly because the codebase's
        // popout-window lint flags it.
        if (typeof window === "undefined" || typeof window.fetch !== "function") {
          return Promise.reject(
            new Error(
              "window.fetch is unavailable — ModelCatalogService.refresh() requires a fetch implementation."
            )
          );
        }
        return window.fetch(input, init);
      });
    this.now = overrides.now ?? (() => Date.now());
  }

  /**
   * Returns the process-wide singleton. Lazy — does not allocate until
   * first call.
   */
  static getInstance(): ModelCatalogService {
    if (!ModelCatalogService.instance) {
      ModelCatalogService.instance = new ModelCatalogService();
    }
    return ModelCatalogService.instance;
  }

  /**
   * TEST-ONLY: clears the singleton so a fresh instance can be wired up.
   * Production code should never call this.
   */
  static resetInstanceForTests(): void {
    ModelCatalogService.instance = undefined;
  }

  /**
   * Configure the service with a storage adapter + manifest dir. Safe to
   * call multiple times (later calls overwrite earlier config). Does NOT
   * trigger any I/O on its own.
   */
  init(opts: CatalogServiceInit): void {
    this.adapter = opts.adapter;
    this.manifestDir = opts.manifestDir;
  }

  /**
   * Populate the memory cache. Idempotent — subsequent calls are no-ops.
   *
   * Tries the disk cache first; on any failure (file missing, parse error,
   * etc.) falls back to the bundled snapshot.
   *
   * **Never fetches the network.** Use `refresh()` for that.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadInflight) {
      await this.loadInflight;
      return;
    }
    this.loadInflight = this.doInitialLoad();
    try {
      await this.loadInflight;
    } finally {
      this.loadInflight = null;
    }
  }

  private async doInitialLoad(): Promise<void> {
    const fromDisk = await this.tryReadDisk();
    if (fromDisk) {
      this.memoryCache = fromDisk.data;
      this.memorySource = "disk";
      this.fetchedAt = fromDisk.fetchedAt;
      this.loaded = true;
      logInfo("[ModelCatalogService] Loaded catalog from disk cache.");
      return;
    }
    // No disk cache yet — start empty; the first `refresh()` populates it.
    this.memoryCache = {};
    this.memorySource = "bundled";
    this.fetchedAt = null;
    this.loaded = true;
    logInfo("[ModelCatalogService] No disk cache; awaiting live refresh.");
  }

  /**
   * Live-fetch the catalog with a 5s timeout. On success: replace memory
   * cache, write disk, emit change. On failure: log + keep last loaded
   * source intact.
   *
   * Returns a structured result rather than throwing so callers (the BYOK
   * tab header button) can render a non-fatal error state.
   */
  async refresh(): Promise<RefreshResult> {
    // Make sure something is loaded before we attempt the fetch so a
    // failure leaves us with at least the bundled fallback in memory.
    await this.ensureLoaded();

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    // `window.setTimeout` is used over the bare global per the popout-window
    // lint — both share the same handle type in Electron renderer + jsdom.
    const timer = controller ? window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

    try {
      const response = await this.fetchImpl(CATALOG_URL, {
        signal: controller?.signal,
      });
      if (!response.ok) {
        logWarn(
          `[ModelCatalogService] refresh() got non-200 (${response.status}); keeping ${this.memorySource} source.`
        );
        return {
          ok: false,
          error: `HTTP ${response.status}`,
          source: this.memorySource,
        };
      }
      const payload: unknown = await response.json();
      const filtered = this.filterAndValidate(payload);
      const fetchedAt = this.now();

      this.memoryCache = filtered;
      this.memorySource = "live";
      this.fetchedAt = fetchedAt;

      // Best-effort disk write; failures are non-fatal.
      await this.tryWriteDisk({ fetchedAt, data: filtered });

      this.emitChange();
      logInfo(
        `[ModelCatalogService] refresh() succeeded; ${Object.keys(filtered).length} providers cached.`
      );
      return { ok: true, source: "live" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(
        `[ModelCatalogService] refresh() failed (${message}); keeping ${this.memorySource} source.`
      );
      return { ok: false, error: message, source: this.memorySource };
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  /**
   * Returns the catalog provider with the given id, or `undefined`.
   * Synchronous — caller must have awaited `ensureLoaded()` first.
   */
  getProvider(id: ProviderId): CatalogProvider | undefined {
    return this.requireMemory()[id];
  }

  /**
   * Returns a specific model within a provider, or `undefined`.
   * Synchronous — caller must have awaited `ensureLoaded()` first.
   */
  getModel(providerId: ProviderId, modelId: string): CatalogModel | undefined {
    return this.requireMemory()[providerId]?.models?.[modelId];
  }

  /**
   * Returns all providers in `SUPPORTED_PROVIDER_IDS` order, with the
   * recommended ones (Anthropic / OpenAI / Google) bumped to the front.
   * Providers missing from the catalog (e.g. `ollama`, `openai-compatible`)
   * are skipped.
   */
  getAllProviders(): CatalogProvider[] {
    const cache = this.requireMemory();
    const recommended: CatalogProvider[] = [];
    const rest: CatalogProvider[] = [];

    for (const id of SUPPORTED_PROVIDER_IDS) {
      const provider = cache[id];
      if (!provider) continue;
      if (RECOMMENDED_PROVIDER_IDS.includes(id)) {
        recommended.push(provider);
      } else {
        rest.push(provider);
      }
    }

    // Preserve RECOMMENDED_PROVIDER_IDS ordering explicitly (anthropic →
    // openai → google) regardless of the order they appeared in
    // SUPPORTED_PROVIDER_IDS.
    recommended.sort(
      (a, b) => RECOMMENDED_PROVIDER_IDS.indexOf(a.id) - RECOMMENDED_PROVIDER_IDS.indexOf(b.id)
    );

    return [...recommended, ...rest];
  }

  /**
   * Filters a provider's model list by query string + optional CatalogFilters.
   * Catalog-only — does not consult the registry. Synchronous after
   * `ensureLoaded()` resolves.
   *
   * Filter semantics:
   *  - `query`: case-insensitive substring match against `name` or `id`.
   *  - `contextAtLeast`: keep when `limit.context >= n`.
   *  - `maxCostPerMillion`: keep when `(cost.input + cost.output) <= n`.
   *    Models with no `cost` block are dropped when this filter is active
   *    (we can't prove they're cheap).
   *  - `releasedWithinMonths`: keep when `release_date >= now - months`.
   *    Models with no `release_date` are dropped when this filter is active.
   */
  searchModels(
    providerId: ProviderId,
    query: string,
    filters: CatalogFilters = {}
  ): CatalogModel[] {
    const provider = this.getProvider(providerId);
    if (!provider) return [];

    const normalizedQuery = query.trim().toLowerCase();
    const cutoffMs =
      filters.releasedWithinMonths !== undefined
        ? this.now() - filters.releasedWithinMonths * 30 * 24 * 60 * 60 * 1000
        : null;

    return Object.values(provider.models).filter((model) => {
      if (normalizedQuery) {
        const haystack = `${model.name} ${model.id}`.toLowerCase();
        if (!haystack.includes(normalizedQuery)) return false;
      }
      if (
        filters.contextAtLeast !== undefined &&
        (model.limit?.context ?? 0) < filters.contextAtLeast
      ) {
        return false;
      }
      if (filters.maxCostPerMillion !== undefined) {
        if (!model.cost) return false;
        const total = (model.cost.input ?? 0) + (model.cost.output ?? 0);
        if (total > filters.maxCostPerMillion) return false;
      }
      if (cutoffMs !== null) {
        if (!model.release_date) return false;
        const parsed = Date.parse(model.release_date);
        if (Number.isNaN(parsed) || parsed < cutoffMs) return false;
      }
      return true;
    });
  }

  /**
   * Returns metadata about the active catalog cache. Safe to call before
   * `ensureLoaded()` — reports `source: "bundled"` and `fetchedAt: null`
   * (the eventual state if no disk cache exists).
   */
  getMeta(): CatalogMeta {
    return { fetchedAt: this.fetchedAt, source: this.memorySource };
  }

  /**
   * Subscribe to memory-cache changes (currently only fired on successful
   * `refresh()`). Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ----- internal helpers -----

  /**
   * Resolve the disk-cache path. Throws if `init()` hasn't been called —
   * callers should check `adapter` presence and skip the disk path entirely
   * when uninitialized (the bundled fallback handles that case).
   */
  private getCachePath(): string | undefined {
    if (!this.manifestDir) return undefined;
    return `${this.manifestDir}/${DISK_CACHE_FILENAME}`;
  }

  private async tryReadDisk(): Promise<CatalogDiskCache | null> {
    const path = this.getCachePath();
    if (!path || !this.adapter) return null;
    try {
      if (!(await this.adapter.exists(path))) return null;
      const raw = await this.adapter.read(path);
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as CatalogDiskCache).fetchedAt !== "number" ||
        !(parsed as CatalogDiskCache).data ||
        typeof (parsed as CatalogDiskCache).data !== "object"
      ) {
        logWarn("[ModelCatalogService] Disk cache present but malformed.");
        return null;
      }
      return parsed as CatalogDiskCache;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[ModelCatalogService] Disk cache read failed: ${message}`);
      return null;
    }
  }

  private async tryWriteDisk(cache: CatalogDiskCache): Promise<void> {
    const path = this.getCachePath();
    if (!path || !this.adapter) return;
    try {
      await this.adapter.write(path, JSON.stringify(cache));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[ModelCatalogService] Disk cache write failed: ${message}`);
    }
  }

  /**
   * Defensive filter applied to live payloads — we drop unknown providers
   * and assert a minimal structural shape. A malformed entry on one
   * provider does NOT poison the whole refresh; we just skip it.
   */
  private filterAndValidate(payload: unknown): ModelsCatalog {
    if (!payload || typeof payload !== "object") {
      throw new Error("Catalog payload is not an object");
    }
    const source = payload as Record<string, unknown>;
    const out: ModelsCatalog = {};
    for (const id of SUPPORTED_PROVIDER_IDS) {
      const candidate = source[id];
      if (!candidate || typeof candidate !== "object") continue;
      const provider = candidate as Partial<CatalogProvider>;
      if (
        typeof provider.id !== "string" ||
        typeof provider.name !== "string" ||
        !provider.models ||
        typeof provider.models !== "object"
      ) {
        logWarn(
          `[ModelCatalogService] Skipping provider '${id}' in live payload (missing required fields).`
        );
        continue;
      }
      out[id] = provider as CatalogProvider;
    }
    return out;
  }

  private requireMemory(): ModelsCatalog {
    if (!this.memoryCache) {
      // The lazy contract says callers await `ensureLoaded()`; if they
      // haven't, return an empty catalog rather than crashing.
      return {};
    }
    return this.memoryCache;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        // A listener bug should not poison the change-fanout for everyone
        // else. Swallow + log; the listener's owner will see the issue
        // when their UI doesn't update.
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`[ModelCatalogService] onChange listener threw: ${message}`);
      }
    }
  }
}
