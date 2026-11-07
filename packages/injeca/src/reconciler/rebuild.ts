import type { InstanceNode, StopIntent, UnitNode } from '../graph/graph'

import { resolvedInstance } from '../graph/resolvers/resolvers'
import { enterStopping } from './stop'
import { createSuccessor } from './swap'

/**
 * Tells whether the old instance of a running unit can keep serving while its successor builds and starts.
 *
 * - Only a unit with a key rebuilds make-before-break. An invocation has no dependents, so it stops, then runs again.
 * - Each edge that the old instance is bound to still resolves, maybe to a new instance. An edge without a provider has nothing to build against, so the unit stops first.
 * - The container is not in disposal.
 *
 * A bound provider instance stays usable until its last holder releases it, so the old instance keeps working with its bindings.
 */
function keepsServing(unit: UnitNode, instance: InstanceNode): boolean {
  if (unit.kind !== 'unit' || unit.container.state !== 'active')
    return false

  return unit.edges.every(edge => !instance.bindings.has(edge.name) || resolvedInstance(unit, edge) !== undefined)
}

/**
 * Rebuilds a running unit, for a changed dependency without a handler, or for a `rebuild` decision.
 *
 * When the old instance can keep serving, the rebuild is make-before-break: a successor with the same options builds and starts against the current dependencies.
 * The old instance serves until the successor completes `start`. Then one batch swaps them, as for `replace()`. The dependents get `dependency-change`, not a withdrawal.
 * If the successor fails, the old instance stops and the unit goes to `failed`.
 * Otherwise the unit stops first and builds again from `pending`.
 *
 * A replacement in progress, from `replace()` or a transaction, takes precedence. The old instance serves until it ends, and the unit reconciles again then.
 */
export function rebuild(unit: UnitNode, instance: InstanceNode, intent: StopIntent): void {
  if (unit.successor)
    return
  if (!keepsServing(unit, instance)) {
    enterStopping(unit, intent)
    return
  }

  const { registration } = unit
  const { unit: successor } = createSuccessor(unit, unit, {
    template: unit.template,
    rebuild: true,
    onSettle: (next, outcome) => {
      if (registration?.pending === next)
        registration.pending = undefined
      if (outcome.kind === 'swapped' && registration)
        registration.current = next
      // The old instance stops for the rebuild only now, so the observe stream gets the decision and the reason of the rebuild.
      if (outcome.kind === 'swapped' && unit.signals.phase() === 'running')
        enterStopping(unit, intent)
      if (outcome.kind === 'failed' && unit.signals.present())
        enterStopping(unit, { failure: { error: outcome.error }, reason: 'The rebuild failed. The old instance stops.', decision: intent.decision })
      unit.container.runtime.reconciler.markDirty(unit)
    },
  })
  // `replace()` and `withdraw()` of the registration cancel the rebuild, as they cancel a pending replacement.
  if (registration)
    registration.pending = successor
}
