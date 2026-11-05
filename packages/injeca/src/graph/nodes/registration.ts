import type { ContainerNode, RegistrationNode, ServiceNode } from '../graph'

import { batch, untracked } from '../../helpers/signals'
import { awaitWithdrawal, releaseService } from './container'

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

/** The `withdraw()` of a registration. Resolves `false` for a stale registration. Rejects with the teardown errors. */
export async function withdrawRegistration(registration: RegistrationNode): Promise<boolean> {
  const service = untracked(() => {
    const current = currentService(registration)
    if (current) {
      batch(() => {
        cancelPending(registration)
        releaseService(current)
      })
    }

    return current
  })
  if (!service)
    return false

  await awaitWithdrawal(service)
  return true
}
