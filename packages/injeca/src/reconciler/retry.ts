import type { UnitNode } from '../graph/graph'

import { setPhase } from '../graph/nodes'
import { requiredWithdrawn } from '../graph/resolvers/resolvers'
import { cancelRequeueWait } from './requeue'
import { runStart } from './start'
import { enterStopping } from './stop'

function lostReason(unit: UnitNode): string {
  if (!unit.signals.present())
    return unit.replacedBy ? 'The unit was replaced during a start requeue.' : 'The unit was withdrawn during a start requeue.'
  if (!unit.signals.active())
    return 'The container stopped during a start requeue.'
  if (requiredWithdrawn(unit))
    return 'A required dependency was withdrawn during a start requeue.'

  return `The exclusive key '${unit.name}' got another declaration during a start requeue.`
}

/**
 * Handles a unit in `retrying`: a `start` hook returned `requeue`.
 *
 * Changes during the wait merge into the next attempt. When the wait ends, `start` runs again with the same instance.
 * A requeue cannot keep a unit alive. A lost target, for example a withdrawn required dependency, cancels the wait and stops the unit at once.
 */
export function reconcileRetrying(unit: UnitNode): void {
  const instance = unit.signals.instance()
  if (!instance) {
    enterStopping(unit, {})
    return
  }
  if (unit.signals.targetLost()) {
    cancelRequeueWait(instance)
    enterStopping(unit, { reason: lostReason(unit) })
    return
  }
  if (instance.requeueWait)
    return

  setPhase(unit, 'starting', { reason: 'The requeue wait ended.' })
  void runStart(unit, instance)
}
