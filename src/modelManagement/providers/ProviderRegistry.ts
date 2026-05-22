/**
 * ProviderRegistry — source of truth for provider credentials.
 *
 * Wraps `settings.providers` and emits change notifications so the BYOK UI
 * can re-render when providers are added/edited/removed. Keychain support is
 * deferred — M2 stores keys inline; the M9-era keychain promotion path will
 * extend `getApiKey()` and the writers to lift secrets into the OS keychain.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.1.
 */
import type {
  KeychainRef,
  ProviderConfig,
  ProviderId,
  VerificationResult,
} from "@/modelManagement/types";
import { getSettings, setSettings, subscribeToSettingsChange } from "@/settings/model";

/**
 * Singleton facade over `settings.providers`. All callers should use
 * `getInstance()` so listeners share one notification source.
 */
export class ProviderRegistry {
  private static instance: ProviderRegistry | undefined;

  private readonly listeners = new Set<() => void>();
  private unsubscribeSettings: (() => void) | null = null;

  private constructor() {
    // Re-emit whenever settings change — UI may render off `list()` and
    // needs to refresh on programmatic mutations from elsewhere.
    this.unsubscribeSettings = subscribeToSettingsChange((prev, next) => {
      if (prev.providers !== next.providers) {
        this.emit();
      }
    });
  }

  /** Returns the process-wide singleton. */
  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  /** TEST-ONLY hook. */
  static resetInstanceForTests(): void {
    if (ProviderRegistry.instance?.unsubscribeSettings) {
      ProviderRegistry.instance.unsubscribeSettings();
    }
    ProviderRegistry.instance = undefined;
  }

  /**
   * Returns registered providers in insertion order.
   *
   * Pass `filter.kind` to narrow to a single classification — useful for
   * the BYOK UI which displays only `"builtin"` and `"custom"` providers
   * (system providers are credentialed by their agent backend and have no
   * user-configurable surface).
   *
   * No filter → all kinds. Existing callers that just want everything keep
   * working unchanged.
   */
  list(filter?: { kind?: ProviderConfig["kind"] }): ProviderConfig[] {
    const providers = getSettings().providers ?? {};
    const all = Object.values(providers);
    if (!filter?.kind) return all;
    return all.filter((p) => p.kind === filter.kind);
  }

  /** Returns a single provider by id, or `undefined`. */
  get(id: ProviderId): ProviderConfig | undefined {
    return getSettings().providers?.[id];
  }

  /**
   * Add a new provider. `addedAt` is stamped server-side. Listeners
   * fire via the settings-change subscription wired in the constructor —
   * no explicit `emit()` needed.
   */
  async add(config: Omit<ProviderConfig, "addedAt">): Promise<void> {
    const next: ProviderConfig = { ...config, addedAt: Date.now() };
    setSettings((cur) => ({
      providers: { ...(cur.providers ?? {}), [next.id]: next },
    }));
  }

  /** Shallow-merge `patch` into the existing provider. No-op if missing. */
  async update(id: ProviderId, patch: Partial<ProviderConfig>): Promise<void> {
    setSettings((cur) => {
      const existing = cur.providers?.[id];
      if (!existing) return {};
      const updated: ProviderConfig = { ...existing, ...patch, id };
      return { providers: { ...(cur.providers ?? {}), [id]: updated } };
    });
  }

  /**
   * Remove a provider AND cascade-delete all registry entries that
   * reference it. Mirrors the design's "Remove provider" kebab action.
   */
  async remove(id: ProviderId): Promise<void> {
    setSettings((cur) => {
      const providers = { ...(cur.providers ?? {}) };
      delete providers[id];
      const registry = (cur.registry ?? []).filter((entry) => entry.providerId !== id);
      return { providers, registry };
    });
  }

  /**
   * Resolve the provider's API key. `kind: "inline"` returns the value
   * directly; `kind: "keychain"` will (in a future milestone) read from
   * `KeychainService`. M2 only supports inline.
   *
   * Returns `null` if the provider has no key set or doesn't exist.
   * Async-by-contract so the keychain milestone can swap in I/O without
   * changing call sites.
   */
  async getApiKey(id: ProviderId): Promise<string | null> {
    const provider = this.get(id);
    if (!provider?.apiKeyRef) return null;
    return resolveApiKeySync(provider.apiKeyRef);
  }

  /**
   * Stub verification. Real implementation (M5) will dispatch to the
   * provider's adapter — for now we just check that an API key exists.
   */
  async verify(id: ProviderId): Promise<VerificationResult> {
    const key = await this.getApiKey(id);
    const provider = this.get(id);
    if (!provider) {
      return {
        ok: false,
        error: `Unknown provider '${id}'`,
        verifiedAt: Date.now(),
      };
    }
    if (provider.apiKeyRef !== null && !key) {
      return {
        ok: false,
        error: "No API key configured",
        verifiedAt: Date.now(),
      };
    }
    return { ok: true, verifiedAt: Date.now() };
  }

  /** Subscribe to provider mutations. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not poison the fanout. The caller will
        // see their bug when their UI stops updating.
      }
    }
  }
}

/**
 * Public helper for non-class consumers: read a provider's API key by id.
 * Equivalent to `ProviderRegistry.getInstance().getApiKey(id)`.
 */
export async function getProviderApiKey(id: ProviderId): Promise<string | null> {
  return ProviderRegistry.getInstance().getApiKey(id);
}

/**
 * Synchronous accessor for an inline-stored API key. Returns `null` if the
 * key is in the keychain (force the caller to use the async variant) or if
 * the provider doesn't exist.
 *
 * Useful for hot-path code that can't await — e.g. inside a `setSettings`
 * updater. M9 will deprecate this once keychain promotion is universal.
 */
export function getProviderApiKeySync(id: ProviderId): string | null {
  const provider = getSettings().providers?.[id];
  if (!provider?.apiKeyRef) return null;
  return resolveApiKeySync(provider.apiKeyRef);
}

/** Inline-only resolver. Keychain support lands in a follow-up. */
function resolveApiKeySync(ref: KeychainRef): string | null {
  return ref.kind === "inline" ? ref.value : null;
}
