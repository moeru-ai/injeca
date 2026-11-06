import type { ContainerNode, RegistrationNode, UnitNode } from '../graph'

import { batch, untracked } from '../../helpers/signals'
import { releaseUnit } from './container'

export function createRegistration(container: ContainerNode, name: string, exclusive: boolean): RegistrationNode {
  return { container, name, exclusive, current: undefined, pending: undefined }
}

/**
 * The published unit of a registration that is still current, or `undefined` for a stale registration.
 * A registration is stale after its own withdrawal, or after a newer `provide` of the same key in the same container.
 */
export function currentUnit(registration: RegistrationNode): UnitNode | undefined {
  const unit = registration.current
  return unit?.signals.present() ? unit : undefined
}

/** Cancels the replacement that waits for its swap. The old unit does not change. */
export function cancelPending(registration: RegistrationNode): void {
  const pending = registration.pending
  if (!pending)
    return

  registration.pending = undefined
  pending.swap?.settle({ kind: 'cancelled' })
  releaseUnit(pending)
}

/** Cancels the successor that waits to replace `unit`, for example a make-before-break rebuild. `unit` does not change. */
export function cancelSuccessor(unit: UnitNode): void {
  const successor = unit.successor
  if (!successor)
    return

  unit.successor = undefined
  successor.swap?.settle({ kind: 'cancelled' })
  releaseUnit(successor)
}

/** Releases the current unit of a registration and cancels its pending replacement. Returns the unit, or `undefined` for a stale registration. */
export function releaseRegistration(registration: RegistrationNode): UnitNode | undefined {
  return untracked(() => {
    const current = currentUnit(registration)
    if (current) {
      batch(() => {
        cancelPending(registration)
        releaseUnit(current)
      })
    }

    return current
  })
}
