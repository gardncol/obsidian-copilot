/**
 * ModelRegistry — source of truth for the BYOK model registry.
 *
 * Wraps `settings.registry` and emits change events. Reads/writes flow
 * through `setSettings(...)` so the existing Jotai store keeps the rest of
 * the UI in sync.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.2.
 */
import type { ProviderId, RegistryEntry } from "@/modelManagement/types";
import { getSettings, setSettings, subscribeToSettingsChange } from "@/settings/model";

/** Structured handle to a registry entry — the storage shape for the user's chosen default chat model. */
export interface ModelRef {
  providerId: ProviderId;
  modelId: string;
}

/** Filter accepted by `ModelRegistry.list()`. */
export interface ModelRegistryFilter {
  /** Restrict to a single provider id. */
  providerId?: ProviderId;
}

/**
 * Per-backend picker key format: `<providerId>:<modelId>`. OpenCode-bundled
 * and Copilot-Plus-hosted models live under their respective `kind: "system"`
 * providers (`opencode`, `copilot-plus`) in `settings.providers` — they're
 * first-class registry entries now, not pseudo-prefixes. See
 * `ProviderConfig.kind` in `@/modelManagement/types`.
 */
export type AgentBackendId = "opencode" | "claude" | "codex" | "quickChat";

/**
 * Singleton facade over `settings.registry`. Production callers should use
 * `getInstance()`.
 */
export class ModelRegistry {
  private static instance: ModelRegistry | undefined;

  private readonly listeners = new Set<() => void>();
  private unsubscribeSettings: (() => void) | null = null;

  private constructor() {
    this.unsubscribeSettings = subscribeToSettingsChange((prev, next) => {
      if (prev.registry !== next.registry) {
        this.emit();
      }
    });
  }

  /** Returns the process-wide singleton. */
  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  /** TEST-ONLY hook. */
  static resetInstanceForTests(): void {
    if (ModelRegistry.instance?.unsubscribeSettings) {
      ModelRegistry.instance.unsubscribeSettings();
    }
    ModelRegistry.instance = undefined;
  }

  /** List all entries, optionally filtered by provider. */
  list(filter?: ModelRegistryFilter): RegistryEntry[] {
    const entries = getSettings().registry ?? [];
    if (!filter) return entries.slice();
    return entries.filter((entry) => {
      if (filter.providerId && entry.providerId !== filter.providerId) return false;
      return true;
    });
  }

  /** Returns a single entry by `(providerId, modelId)`, or `undefined`. */
  get(providerId: ProviderId, modelId: string): RegistryEntry | undefined {
    return this.list().find((e) => e.providerId === providerId && e.modelId === modelId);
  }

  /**
   * Add a new entry. `addedAt` is stamped here. Listeners fire via the
   * settings-change subscription wired in the constructor — no explicit
   * `emit()` needed.
   */
  async add(entry: Omit<RegistryEntry, "addedAt">): Promise<void> {
    const next: RegistryEntry = { ...entry, addedAt: Date.now() };
    setSettings((cur) => {
      const existing = cur.registry ?? [];
      // Replace-on-conflict: same (providerId, modelId) overwrites.
      const filtered = existing.filter(
        (e) => !(e.providerId === next.providerId && e.modelId === next.modelId)
      );
      return { registry: [...filtered, next] };
    });
  }

  /** Remove a single entry. No-op if it doesn't exist. */
  async remove(providerId: ProviderId, modelId: string): Promise<void> {
    setSettings((cur) => {
      const existing = cur.registry ?? [];
      const next = existing.filter((e) => !(e.providerId === providerId && e.modelId === modelId));
      if (next.length === existing.length) return {};
      return { registry: next };
    });
  }

  /**
   * Replace ALL of a provider's entries atomically. Used by the Configure
   * Provider dialog when the user re-saves the checklist.
   */
  async bulkSet(providerId: ProviderId, entries: RegistryEntry[]): Promise<void> {
    const stamped = entries.map((e) => ({
      ...e,
      providerId,
      addedAt: e.addedAt ?? Date.now(),
    }));
    setSettings((cur) => {
      const existing = cur.registry ?? [];
      const others = existing.filter((e) => e.providerId !== providerId);
      return { registry: [...others, ...stamped] };
    });
  }

  /**
   * Returns the entries that should appear in the given agent backend's
   * in-session model picker. Per §2.2:
   *  - OpenCode union of (bundled + Plus + BYOK) is assembled by the OpenCode
   *    panel itself; this method returns the full BYOK list.
   *  - Claude / Codex pickers don't read BYOK — they source from each
   *    backend's bundled list. We return an empty array for them; the
   *    panel layer handles its own list.
   *  - Quick Chat → all BYOK entries.
   *
   * In all cases, the per-backend `modelEnabledOverrides` is honored:
   * missing entry = visible; explicit `false` = hidden.
   */
  listForAgentPicker(backendId: AgentBackendId): RegistryEntry[] {
    const settings = getSettings();
    const overrides = settings.agentMode?.backends?.[backendId]?.modelEnabledOverrides ?? {};
    let pool: RegistryEntry[];
    switch (backendId) {
      case "quickChat":
      case "opencode":
        pool = this.list();
        break;
      case "claude":
      case "codex":
        // Subscription-bound; BYOK does not contribute. The panel's own
        // bundled-models list drives this.
        return [];
      default:
        pool = this.list();
        break;
    }
    return pool.filter((entry) => {
      const key = `${entry.providerId}:${entry.modelId}`;
      // Missing override = visible (true).
      return overrides[key] !== false;
    });
  }

  /**
   * Returns the user's default chat model — read from
   * `settings.defaultModelRef` and resolved through the registry. Falls back
   * to the first available entry when the ref is missing or stale (provider
   * removed, model removed). Returns `undefined` only when the registry is
   * empty.
   */
  getDefault(): RegistryEntry | undefined {
    const ref = getSettings().defaultModelRef;
    if (ref) {
      const entry = this.get(ref.providerId, ref.modelId);
      if (entry) return entry;
    }
    // Fallback: first entry in the registry (insertion order).
    const all = this.list();
    return all[0];
  }

  /**
   * Persist a new default. `null` clears the user's choice; the next
   * `getDefault()` call will fall back to the first registry entry.
   */
  async setDefault(ref: ModelRef | null): Promise<void> {
    setSettings({ defaultModelRef: ref });
  }

  /** Subscribe to registry mutations. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not poison the fanout.
      }
    }
  }
}
