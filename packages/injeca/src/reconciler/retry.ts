import type { ServiceNode } from '../graph/graph'

import { setPhase } from '../graph/nodes'
import { requiredWithdrawn } from '../graph/resolvers/resolvers'
import { cancelRequeueWait } from './requeue'
import { runStart } from './start'
import { enterStopping } from './stop'

function lostReason(service: ServiceNode): string {
  if (!service.signals.present())
    return service.replacedBy ? 'The service was replaced during a start requeue.' : 'The service was withdrawn during a start requeue.'
  if (!service.signals.active())
    return 'The container stopped during a start requeue.'
  if (requiredWithdrawn(service))
    return 'A required dependency was withdrawn during a start requeue.'

  return `The exclusive key '${service.name}' got another declaration during a start requeue.`
}

/**
 * Handles a service in `retrying`: a `start` hook returned `requeue`.
 *
 * Changes during the wait merge into the next attempt. When the wait ends, `start` runs again with the same instance.
 * A requeue cannot keep a service alive. A lost target, for example a withdrawn required dependency, cancels the wait and stops the service at once.
 */
export function reconcileRetrying(service: ServiceNode): void {
  const instance = service.signals.instance()
  if (!instance) {
    enterStopping(service, {})
    return
  }
  if (service.signals.targetLost()) {
    cancelRequeueWait(instance)
    enterStopping(service, { reason: lostReason(service) })
    return
  }
  if (instance.requeueWait)
    return

  setPhase(service, 'starting', { reason: 'The requeue wait ended.' })
  void runStart(service, instance)
}
