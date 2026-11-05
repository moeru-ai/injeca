import type { InstanceNode, ServiceNode, StopIntent } from '../graph/graph'
import type { RequeueDecision } from '../primitives/decision'

/** The delay of a dependency hook requeue in milliseconds. */
function requeueDelay(decision: RequeueDecision): number {
  if (decision.after !== undefined)
    return Math.max(0, decision.after)
  if (decision.backoff) {
    // NOTICE:
    // `jitter` is not applied. The design does not define its unit yet.
    // Backoff details belong to design step 4 ("Requeue", "Delivery" step 4 in docs/design-0.3.md).
    // Removal condition: step 4 defines and applies jitter.
    const { initial, max } = decision.backoff
    return Math.max(0, Math.min(max, initial * 2 ** (decision.attempt - 1)))
  }

  return 0
}

/**
 * The stop intent of a requeue that reached `maxAttempts`. The service stops, then goes to `failed` with the last reason.
 * It is `undefined` when the requeue can wait.
 */
export function exhaustedIntent(service: ServiceNode, decision: RequeueDecision): StopIntent | undefined {
  if (decision.maxAttempts === undefined || decision.attempt < decision.maxAttempts)
    return undefined

  const message = decision.reason ?? `The '${decision.hook}' hook of '${service.name}' reached maxAttempts (${decision.maxAttempts}).`
  return { failure: { error: new Error(message, { cause: decision }) }, reason: message, decision: 'requeue' }
}

/** Waits before the next run of a dependency hook. The service stays `running` with its current bindings. */
export function scheduleRequeue(service: ServiceNode, instance: InstanceNode, decision: RequeueDecision): void {
  const wait: { cancel: () => void } = { cancel: () => {} }
  wait.cancel = service.container.runtime.clock.setTimeout(() => {
    if (instance.requeueWait !== wait)
      return

    instance.requeueWait = undefined
    service.container.runtime.reconciler.markDirty(service)
  }, requeueDelay(decision))
  instance.requeueWait = wait
}

export function cancelRequeueWait(instance: InstanceNode): void {
  instance.requeueWait?.cancel()
  instance.requeueWait = undefined
}
