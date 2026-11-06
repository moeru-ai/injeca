import type { InstanceNode, StopIntent, UnitNode } from '../graph/graph'
import type { RequeueDecision } from '../primitives/decision'

import { maxAttemptsOf } from '../graph/nodes'

/**
 * The delay of a requeue in milliseconds.
 *
 * `after` is a fixed delay. An exponential backoff doubles `initial` for each attempt, up to `max`.
 * `jitter` is a fraction from 0 to 1. It takes a random part of that size away from the delay, so the delay is between `delay * (1 - jitter)` and `delay`.
 */
export function requeueDelay(decision: RequeueDecision, random: () => number): number {
  if (decision.after !== undefined)
    return Math.max(0, decision.after)
  if (decision.backoff) {
    const { initial, max, jitter } = decision.backoff
    const delay = Math.max(0, Math.min(max, initial * 2 ** (decision.attempt - 1)))
    if (jitter === undefined)
      return delay

    const fraction = Math.min(1, Math.max(0, jitter))
    return delay * (1 - fraction * random())
  }

  return 0
}

/**
 * The stop intent of a requeue that reached its attempt limit. The unit stops, then goes to `failed` with the last reason.
 * The limit comes from the decision, then the unit, then the containers. It is `undefined` when the requeue can wait.
 */
export function exhaustedIntent(unit: UnitNode, decision: RequeueDecision): StopIntent | undefined {
  const maxAttempts = maxAttemptsOf(unit, decision.maxAttempts)
  if (maxAttempts === undefined || decision.attempt < maxAttempts)
    return undefined

  const message = decision.reason ?? `The '${decision.hook}' hook of '${unit.name}' reached maxAttempts (${maxAttempts}).`
  return { failure: { error: new Error(message, { cause: decision }) }, reason: message, decision: 'requeue' }
}

/** Waits before the next run of a requeued hook. When the wait ends, the unit goes back to the work queue. */
export function scheduleRequeue(unit: UnitNode, instance: InstanceNode, decision: RequeueDecision): void {
  const { clock, random, reconciler } = unit.container.runtime
  const wait: { cancel: () => void } = { cancel: () => {} }
  wait.cancel = clock.setTimeout(() => {
    if (instance.requeueWait !== wait)
      return

    instance.requeueWait = undefined
    reconciler.markDirty(unit)
  }, requeueDelay(decision, random))
  instance.requeueWait = wait
}

export function cancelRequeueWait(instance: InstanceNode): void {
  instance.requeueWait?.cancel()
  instance.requeueWait = undefined
}
