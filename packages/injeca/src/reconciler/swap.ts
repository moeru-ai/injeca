import type { ServiceNode } from '../graph/graph'

import { publishService, setPhase } from '../graph/nodes'
import { batch } from '../helpers/signals'

/**
 * Cancels a replacement that cannot complete: the old service was withdrawn, or the container stopped.
 * The new service leaves. The old service does not change.
 */
export function checkSwap(service: ServiceNode): void {
  const { swap } = service
  if (!swap || !service.signals.present())
    return

  if (!swap.target.signals.present()) {
    swap.settle({ kind: 'cancelled' })
    service.signals.present(false)
  }
  else if (!service.signals.active()) {
    swap.settle({ kind: 'stopping' })
    service.signals.present(false)
  }
}

/**
 * Swaps a new service that completed `start` in for the old one, in one batch.
 *
 * The new service takes the slot and goes to `running`. The old service leaves.
 * It stops and disposes after each holder releases it. Dependents follow the rule for a replaced dependency.
 */
export function completeSwap(service: ServiceNode): void {
  const swap = service.swap
  if (!swap)
    return

  const { target } = swap
  service.swap = undefined
  batch(() => {
    target.replacedBy = service
    publishService(service)
    target.signals.present(false)
    setPhase(service, 'running', { reason: `The new instance replaced '${target.signals.instance()?.id ?? target.name}'.` })
  })
  swap.settle({ kind: 'swapped' })
}
