import type { UnitNode } from '../graph/graph'

import { setPhase } from '../graph/nodes'
import { inConflict } from '../graph/resolvers/exclusive'
import { finalize } from './stop'

/** A unit in `conflict` runs no code. It goes back to `pending` when only one declaration remains. */
export function reconcileConflict(unit: UnitNode): void {
  if (!unit.signals.present()) {
    finalize(unit)
    return
  }
  if (inConflict(unit))
    return

  setPhase(unit, 'pending', { reason: `Only one declaration of the exclusive key '${unit.name}' remains.` })
  unit.container.runtime.reconciler.markDirty(unit)
}
