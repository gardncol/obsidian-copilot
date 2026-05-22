/**
 * Tiny helpers shared by the four agent backend panels (Opencode, Claude
 * Code, Codex, Quick Chat). Each panel was carrying a copy of these — they
 * live here so the panels stay focused on layout.
 */
import { listBackendDescriptors, type BackendDescriptor } from "@/agentMode";

/**
 * Compose the `<providerId>:<modelId>` key used for `modelEnabledOverrides`
 * on backends whose model identifier isn't already provider-qualified.
 *
 * Currently only Quick Chat uses this — Quick Chat routes through multiple
 * BYOK providers within a single backend slice, so the BYOK `modelId` alone
 * (e.g. `claude-opus-4-7`) can collide across providers. Pair it with
 * `providerId` to disambiguate.
 *
 * The other agent backends (OpenCode / Claude Code / Codex) store overrides
 * under the bare wire-form `baseModelId` because their `modelId` already
 * encodes the provider segment (`anthropic/claude-…`) or because the
 * backend is single-provider.
 */
export function modelKey(a: string, b: string): string {
  return `${a}:${b}`;
}

/** Look up a backend descriptor by id via the public agentMode barrel. */
export function findDescriptor(id: string): BackendDescriptor | undefined {
  return listBackendDescriptors().find((d) => d.id === id);
}
