/**
 * Shared formatters for catalog-sourced model metadata (context window,
 * release date). Used by both the catalog picker
 * (`ProviderCatalogList`) and the configured-models table
 * (`ByokGlobalTable`) so the same value renders identically wherever it
 * appears.
 */

/**
 * Format a token-count context window as a compact label.
 *
 *  - `>= 1_000_000` → `"1.5M"` (one decimal, trailing `.0` trimmed)
 *  - `>= 1_000`     → `"200k"` (rounded)
 *  - smaller        → the number as-is
 *  - missing/zero/negative → `null` so callers can skip rendering
 */
export function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

/**
 * Pretty-print a catalog `release_date` (ISO-ish "YYYY-MM-DD") as e.g.
 * `Sep 2025`. Falls back to the raw string if parsing fails, and returns
 * an empty string for missing input so callers can render unconditionally.
 */
export function formatReleaseDate(raw: string | undefined): string {
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return raw;
  return new Date(parsed).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
