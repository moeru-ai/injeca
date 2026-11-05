import type { ServiceNode } from '../graph/graph'

import { setPhase } from '../graph/nodes'
import { inConflict } from '../graph/resolvers/exclusive'
import { finalize } from './stop'

/**
 * Handles a `perConsumer` registration. It never builds. The service of each consumer container builds.
 * A withdrawn registration finalizes after its last consumer service.
 */
export function reconcileRegistration(service: ServiceNode): void {
  const phase = service.signals.phase()
  if (!service.signals.present()) {
    if (service.signals.consumers().size === 0)
      finalize(service)
    return
  }

  if (phase === 'pending' && inConflict(service))
    setPhase(service, 'conflict', { reason: `The exclusive key '${service.name}' has more than one declaration.` })
  else if (phase === 'conflict' && !inConflict(service))
    setPhase(service, 'pending', { reason: `Only one declaration of the exclusive key '${service.name}' remains.` })
}
