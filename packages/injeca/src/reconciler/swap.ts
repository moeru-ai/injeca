import type { ServiceDefinition, ServiceNode, SwapOutcome } from '../graph/graph'
import type { CreateServiceInput } from '../graph/nodes'

import { createService, publishService, setPhase } from '../graph/nodes'
import { createDeferred } from '../helpers/deferred'
import { batch } from '../helpers/signals'

/** A new service that waits for its swap, with the outcome of the swap. */
export interface PendingSwap {
  readonly service: ServiceNode
  readonly outcome: Promise<SwapOutcome>
}

export interface SuccessorOptions {
  /** The `perConsumer` registration of a consumer successor. */
  readonly template?: ServiceNode
  /** Runs when the replacement ends, before the outcome settles. */
  readonly onSettle: (service: ServiceNode, outcome: SwapOutcome) => void
  /** The first phase and the transaction of a successor that a transaction creates. */
  readonly extra?: Pick<CreateServiceInput, 'phase' | 'transaction'>
  /** Set for a consumer successor of a `perConsumer` replacement. See `SwapState.ready`. */
  readonly ready?: (service: ServiceNode) => void
  /** `true` for the successor of a make-before-break rebuild. */
  readonly rebuild?: boolean
}

/**
 * Creates a new service that replaces `target` after it completes `start`. It is not published before the swap.
 * `target.successor` names it until the replacement ends. It gets the demand of `target`, so that it converges as `target` does.
 */
export function createSuccessor(target: ServiceNode, definition: ServiceDefinition, options: SuccessorOptions): PendingSwap {
  const outcome = createDeferred<SwapOutcome>()
  let settled = false
  let service: ServiceNode | undefined

  batch(() => {
    service = createService({
      container: target.container,
      kind: 'service',
      name: target.name,
      edges: definition.edges,
      build: definition.build,
      metadata: definition.metadata,
      policy: definition.policy,
      exclusive: target.exclusive,
      exported: target.exported,
      template: options.template,
      consumer: target.consumer,
      registration: target.registration,
      // A rebuild is the same registration, so the successor keeps its place in registration order.
      ...(options.rebuild ? { seq: target.seq } : {}),
      ...options.extra,
      swap: {
        target,
        ready: options.ready,
        held: false,
        ...(options.rebuild ? { rebuild: true } : {}),
        settle: (result) => {
          if (settled)
            return

          settled = true
          if (target.successor === service)
            target.successor = undefined
          options.onSettle(service!, result)
          outcome.resolve(result)
        },
      },
    })
    service.signals.demanded(target.signals.demanded())
    service.signals.subscribers(target.signals.subscribers())
    target.container.services.add(service)
    target.successor = service
  })

  return { service: service!, outcome: outcome.promise }
}

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
