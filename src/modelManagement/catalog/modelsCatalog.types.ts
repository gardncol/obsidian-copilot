/**
 * Hand-rolled TypeScript types matching the `models.dev/api.json` shape
 * (and the disk-cached / bundled-fallback subsets thereof).
 *
 * Schema is verified against the live endpoint as of 2026-05. If `models.dev`
 * changes shape, `ModelCatalogService.refresh()` should reject the payload
 * and keep serving the last good source.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §1.3.
 */

/**
 * A provider entry in the catalog. `models` is keyed by the model's id so
 * that callers can do `provider.models[modelId]` directly.
 */
export interface CatalogProvider {
  /** Canonical id, e.g. `"anthropic"`. */
  id: string;
  /** Display label, e.g. `"Anthropic"`. */
  name: string;
  /** Environment variables the upstream tooling looks at (informational). */
  env: string[];
  /** npm package the upstream SDK ships as (informational). */
  npm?: string;
  /** Default base URL for the provider's API. */
  api?: string;
  /** Models keyed by id. */
  models: Record<string, CatalogModel>;
}

/**
 * A single model entry in the catalog.
 *
 * Capabilities (`reasoning`, `tool_call`, `attachment`, etc.) are present
 * for internal routing only — they are NOT surfaced as user-editable
 * settings or filter chips per the redesign.
 */
export interface CatalogModel {
  /** Model id as accepted by the provider's API. */
  id: string;
  /** Display label. */
  name: string;
  /** Family for grouping in the Configure Provider UI (e.g. "Claude 4"). */
  family?: string;
  /** Accepts file attachments. */
  attachment?: boolean;
  /** Supports reasoning / thinking traces. */
  reasoning?: boolean;
  /** Supports tool calling. */
  tool_call?: boolean;
  /** Supports the `temperature` parameter. */
  temperature?: boolean;
  /** Training data cutoff date (e.g. `"2024-04"`). */
  knowledge?: string;
  /** Release date (e.g. `"2025-09-29"`). Surfaced as "Sep 2025" in the UI. */
  release_date?: string;
  /** Last updated date in the upstream catalog. */
  last_updated?: string;
  /** Whether the model has open weights. */
  open_weights?: boolean;
  /** Input/output modalities (e.g. `input: ["text", "image"]`). */
  modalities: { input: string[]; output: string[] };
  /** Context and output token limits. */
  limit: { context: number; output: number };
  /** Per-million-token costs. Optional — some catalog entries omit it. */
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
}

/**
 * The catalog as a whole: a map of provider id → provider entry.
 *
 * The disk cache and bundled fallback use this exact shape (with the
 * tree-shaken set of providers per `SUPPORTED_PROVIDER_IDS`).
 */
export type ModelsCatalog = Record<string, CatalogProvider>;

/**
 * Filters accepted by `ModelCatalogService.searchModels`. Each is optional;
 * multiple filters are AND-combined.
 *
 * No capability filter — Vision / Reasoning / Tool use chips were removed
 * from the UI per the redesign (§1.4).
 */
export interface CatalogFilters {
  /** Drop models whose `limit.context` is less than this. */
  contextAtLeast?: number;
  /** Drop models whose `cost.input + cost.output` exceeds this (per million). */
  maxCostPerMillion?: number;
  /** Drop models whose `release_date` is older than `now - months`. */
  releasedWithinMonths?: number;
}

/**
 * Where the in-memory cache was populated from.
 *
 * - `"live"`: most recent successful fetch from `models.dev/api.json`.
 * - `"disk"`: read from the on-disk cache file written by an earlier fetch.
 * - `"bundled"`: the committed offline snapshot (first launch, no internet).
 */
export type CatalogSource = "live" | "disk" | "bundled";

/**
 * Metadata about the active catalog cache. Surfaced in the BYOK header
 * (last-fetched timestamp tooltip).
 */
export interface CatalogMeta {
  /** Epoch millis of the last successful live fetch, or `null` if never. */
  fetchedAt: number | null;
  source: CatalogSource;
}

/**
 * Result of a `refresh()` call.
 */
export interface RefreshResult {
  ok: boolean;
  /** Human-readable error if `ok === false`. */
  error?: string;
  source: CatalogSource;
}

/**
 * Shape of the JSON file written to disk after a successful live fetch.
 */
export interface CatalogDiskCache {
  fetchedAt: number;
  data: ModelsCatalog;
}
