import type { SwapOutcome, UnitDefinition, UnitNode } from '../graph/graph'
import type { CreateUnitInput } from '../graph/nodes'

import { createUnit, publishUnit, setPhase } from '../graph/nodes'
import { createDeferred } from '../helpers/deferred'
import { batch } from '../helpers/signals'

/** A new unit that waits for its swap, with the outcome of the swap. */
export interface PendingSwap {
  readonly unit: UnitNode
  readonly outcome: Promise<SwapOutcome>
}

export interface SuccessorOptions {
  /** The per-container registration of a consumer successor. */
  readonly template?: UnitNode
  /** Runs when the replacement ends, before the outcome settles. */
  readonly onSettle: (unit: UnitNode, outcome: SwapOutcome) => void
  /** The first phase and the transaction of a successor that a transaction creates. */
  readonly extra?: Pick<CreateUnitInput, 'phase' | 'transaction'>
  /** Set for a consumer successor of a per-container replacement. See `SwapState.ready`. */
  readonly ready?: (unit: UnitNode) => void
  /** `true` for the successor of a make-before-break rebuild. */
  readonly rebuild?: boolean
}

/**
 * Creates a new unit that replaces `target` after it completes `start`. It is not published before the swap.
 * `target.successor` names it until the replacement ends. It gets the demand of `target`, so that it converges as `target` does.
 */
export function createSuccessor(target: UnitNode, definition: UnitDefinition, options: SuccessorOptions): PendingSwap {
  const outcome = createDeferred<SwapOutcome>()
  let settled = false
  let unit: UnitNode | undefined

  batch(() => {
    unit = createUnit({
      container: target.container,
      kind: 'unit',
      name: target.name,
      edges: definition.edges,
      build: definition.build,
      metadata: definition.metadata,
      policy: definition.policy,
      exclusive: target.exclusive,
      visibility: target.visibility,
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
          if (target.successor === unit)
            target.successor = undefined
          options.onSettle(unit!, result)
          outcome.resolve(result)
        },
      },
    })
    unit.signals.demanded(target.signals.demanded())
    unit.signals.subscribers(target.signals.subscribers())
    target.container.units.add(unit)
    target.successor = unit
  })

  return { unit: unit!, outcome: outcome.promise }
}

/**
 * Cancels a replacement that cannot complete: the old unit was withdrawn, or the container stopped.
 * The new unit leaves. The old unit does not change.
 */
export function checkSwap(unit: UnitNode): void {
  const { swap } = unit
  if (!swap || !unit.signals.present())
    return

  if (!swap.target.signals.present()) {
    swap.settle({ kind: 'cancelled' })
    unit.signals.present(false)
  }
  else if (!unit.signals.active()) {
    swap.settle({ kind: 'stopping' })
    unit.signals.present(false)
  }
}

/**
 * Swaps a new unit that completed `start` in for the old one, in one batch.
 *
 * The new unit takes the slot and goes to `running`. The old unit leaves.
 * It stops and disposes after each holder releases it. Dependents follow the rule for a replaced dependency.
 */
export function completeSwap(unit: UnitNode): void {
  const swap = unit.swap
  if (!swap)
    return

  const { target } = swap
  unit.swap = undefined
  batch(() => {
    target.replacedBy = unit
    publishUnit(unit)
    target.signals.present(false)
    setPhase(unit, 'running', { reason: `The new instance replaced '${target.signals.instance()?.id ?? target.name}'.` })
  })
  swap.settle({ kind: 'swapped' })
}
