import type { InstanceNode, ServiceNode, StopIntent } from '../graph/graph'

import { resolvedInstance } from '../graph/resolvers/resolvers'
import { enterStopping } from './stop'
import { createSuccessor } from './swap'

/**
 * Tells whether the old instance of a running service can keep serving while its successor builds and starts.
 *
 * - Only a service with a key rebuilds make-before-break. An invocation has no dependents, so it stops, then runs again.
 * - Each edge that the old instance is bound to still resolves, maybe to a new instance. An edge without a provider has nothing to build against, so the service stops first.
 * - The container is not in disposal.
 *
 * A bound provider instance stays usable until its last holder releases it, so the old instance keeps working with its bindings.
 */
function keepsServing(service: ServiceNode, instance: InstanceNode): boolean {
  if (service.kind !== 'service' || service.container.state !== 'active')
    return false

  return service.edges.every(edge => !instance.bindings.has(edge.name) || resolvedInstance(service, edge) !== undefined)
}

/**
 * Rebuilds a running service, for a changed dependency without a handler, or for a `rebuild` decision.
 *
 * When the old instance can keep serving, the rebuild is make-before-break: a successor with the same options builds and starts against the current dependencies.
 * The old instance serves until the successor completes `start`. Then one batch swaps them, as for `replace()`. The dependents get `dependency-change`, not a withdrawal.
 * If the successor fails, the old instance stops and the service goes to `failed`.
 * Otherwise the service stops first and builds again from `pending`.
 *
 * A replacement in progress, from `replace()` or a transaction, takes precedence. The old instance serves until it ends, and the service reconciles again then.
 */
export function rebuild(service: ServiceNode, instance: InstanceNode, intent: StopIntent): void {
  if (service.successor)
    return
  if (!keepsServing(service, instance)) {
    enterStopping(service, intent)
    return
  }

  const { registration } = service
  const { service: successor } = createSuccessor(service, service, {
    template: service.template,
    rebuild: true,
    onSettle: (next, outcome) => {
      if (registration?.pending === next)
        registration.pending = undefined
      if (outcome.kind === 'swapped' && registration)
        registration.current = next
      // The old instance stops for the rebuild only now, so the observe stream gets the decision and the reason of the rebuild.
      if (outcome.kind === 'swapped' && service.signals.phase() === 'running')
        enterStopping(service, intent)
      if (outcome.kind === 'failed' && service.signals.present())
        enterStopping(service, { failure: { error: outcome.error }, reason: 'The rebuild failed. The old instance stops.', decision: intent.decision })
      service.container.runtime.reconciler.markDirty(service)
    },
  })
  // `replace()` and `withdraw()` of the registration cancel the rebuild, as they cancel a pending replacement.
  if (registration)
    registration.pending = successor
}
