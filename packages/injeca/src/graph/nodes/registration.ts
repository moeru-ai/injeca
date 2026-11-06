import type { ContainerNode, RegistrationNode, ServiceNode } from '../graph'

import { batch, untracked } from '../../helpers/signals'
import { releaseService } from './container'

export function createRegistration(container: ContainerNode, name: string, exclusive: boolean): RegistrationNode {
  return { container, name, exclusive, current: undefined, pending: undefined }
}

/**
 * The published service of a registration that is still current, or `undefined` for a stale registration.
 * A registration is stale after its own withdrawal, or after a newer `provide` of the same key in the same container.
 */
export function currentService(registration: RegistrationNode): ServiceNode | undefined {
  const service = registration.current
  return service?.signals.present() ? service : undefined
}

/** Cancels the replacement that waits for its swap. The old service does not change. */
export function cancelPending(registration: RegistrationNode): void {
  const pending = registration.pending
  if (!pending)
    return

  registration.pending = undefined
  pending.swap?.settle({ kind: 'cancelled' })
  releaseService(pending)
}

/** Cancels the successor that waits to replace `service`, for example a make-before-break rebuild. `service` does not change. */
export function cancelSuccessor(service: ServiceNode): void {
  const successor = service.successor
  if (!successor)
    return

  service.successor = undefined
  successor.swap?.settle({ kind: 'cancelled' })
  releaseService(successor)
}

/** Releases the current service of a registration and cancels its pending replacement. Returns the service, or `undefined` for a stale registration. */
export function releaseRegistration(registration: RegistrationNode): ServiceNode | undefined {
  return untracked(() => {
    const current = currentService(registration)
    if (current) {
      batch(() => {
        cancelPending(registration)
        releaseService(current)
      })
    }

    return current
  })
}
