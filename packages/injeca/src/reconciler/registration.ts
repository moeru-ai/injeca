import type { UnitNode } from '../graph/graph'

import { setPhase } from '../graph/nodes'
import { inConflict } from '../graph/resolvers/exclusive'
import { finalize } from './stop'

/**
 * Handles a per-container registration. It never builds. The unit of each consumer container builds.
 * A withdrawn registration finalizes after its last consumer unit.
 */
export function reconcileRegistration(unit: UnitNode): void {
  const phase = unit.signals.phase()
  if (!unit.signals.present()) {
    if (unit.signals.consumers().size === 0)
      finalize(unit)
    return
  }

  if (phase === 'pending' && inConflict(unit))
    setPhase(unit, 'conflict', { reason: `The exclusive key '${unit.name}' has more than one declaration.` })
  else if (phase === 'conflict' && !inConflict(unit))
    setPhase(unit, 'pending', { reason: `Only one declaration of the exclusive key '${unit.name}' remains.` })
}
