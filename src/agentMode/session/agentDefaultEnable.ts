/**
 * On a backend's first enrollment, `AgentSetupApi` auto-enrolls every reported
 * model. We don't want a fresh enrollment to flood the picker with a backend's
 * whole catalog, so the discovery wiring narrows the enabled set to a single
 * model: the one the agent reports as currently active.
 */

/** A freshly-enrolled model: its assigned `configuredModelId` and the wire id it came from. */
export interface EnrolledModelRef {
  configuredModelId: string;
  wireModelId: string;
}

/**
 * The single enrolled id to enable on first enrollment: the model the agent
 * reports as current, falling back to the first enrolled model when the current
 * one isn't enrolled (e.g. it was suppressed as a Copilot-managed opencode
 * model). Empty when nothing enrolled.
 */
export function computeDefaultEnabledIds(
  enrolled: readonly EnrolledModelRef[],
  currentWireId: string | undefined
): string[] {
  if (enrolled.length === 0) return [];
  const current = enrolled.find((e) => e.wireModelId === currentWireId);
  return [(current ?? enrolled[0]).configuredModelId];
}
