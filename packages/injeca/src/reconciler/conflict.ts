import type { ServiceNode } from '../graph/graph'

import { setPhase } from '../graph/nodes'
import { inConflict } from '../graph/resolvers/exclusive'
import { finalize } from './stop'

/** A service in `conflict` runs no code. It goes back to `pending` when only one declaration remains. */
export function reconcileConflict(service: ServiceNode): void {
  if (!service.signals.present()) {
    finalize(service)
    return
  }
  if (inConflict(service))
    return

  setPhase(service, 'pending', { reason: `Only one declaration of the exclusive key '${service.name}' remains.` })
  service.container.runtime.reconciler.markDirty(service)
}
