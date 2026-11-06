import type { InstanceNode, ServiceNode, StopIntent } from '../graph/graph'
import type { CleanupFrame } from '../helpers/cleanup-context'

import { HookTimeoutError } from '../diagnostics/errors'
import { setPhase, timeoutOf } from '../graph/nodes'
import { removeDeclaration } from '../graph/resolvers/exclusive'
import { anySignal, raceAbort, timeoutSignal } from '../helpers/abort'
import { batch } from '../helpers/signals'
import { invokeUser, loggerOf } from './calls'
import { syncHolds } from './holds'
import { callHandler, decideTimeout, finishRun, recordDecision } from './hook-run'
import { serviceFrame } from './reentry'
import { cancelRequeueWait } from './requeue'

export function mergeIntent(current: StopIntent, next: StopIntent): StopIntent {
  // A failure wins over a park. The first failure is kept.
  if (current.failure)
    return current
  if (next.failure)
    return next

  return {
    parkEpoch: next.parkEpoch ?? current.parkEpoch,
    reason: next.reason ?? current.reason,
    decision: next.decision ?? current.decision,
  }
}

export function enterStopping(service: ServiceNode, intent: StopIntent): void {
  service.stopIntent = mergeIntent(service.stopIntent, intent)
  setPhase(service, 'stopping', { reason: service.stopIntent.reason, decision: service.stopIntent.decision })
  service.container.runtime.reconciler.markDirty(service)
}

export function reconcileStopping(service: ServiceNode): void {
  const instance = service.signals.instance()
  if (!instance) {
    settleAfterStop(service, [])
    return
  }
  // A provider waits until all its holders release it.
  if (instance.signals.holders().size > 0)
    return

  void teardown(service, instance, true)
}

/**
 * Runs the `stop` hooks in reverse order, then the effect disposers in reverse order.
 *
 * A configured `stop` timeout covers all of them. It is a timeout signal on the container clock. The `stop` handlers get it in their `signal`.
 * When it aborts, injeca records it, warns, applies the `onTimeout` decision, and stops waiting. Without `onTimeout`, the timeout counts as `handled`, so the callers of `stop()` and `dispose()` do not fail.
 * The callback in progress is abandoned. The remaining callbacks still run, but injeca does not wait for them. So a cleanup that awaits the disposal of its own container without its signal cannot block that disposal.
 */
/** The warning of a `stop` timeout. During a stop or a disposal of the container, it tells the most common cause. */
function stopTimeoutWarning(service: ServiceNode, timeoutMs: number): string {
  const warning = `The cleanups of '${service.name}' did not settle within the stop timeout of ${timeoutMs}ms. injeca stopped waiting for them, and the stop continues.`
  const { container } = service
  const action = container.state === 'disposing' ? 'disposing' : container.signals.started() ? undefined : 'stopping'
  if (!action)
    return warning

  return `${warning} The container is ${action}. A cleanup can be waiting for its own container. It must pass its signal to stop() or dispose().`
}

async function runTeardownCallbacks(service: ServiceNode, instance: InstanceNode, stopHooks: boolean, frame: CleanupFrame | undefined): Promise<unknown[]> {
  const errors: unknown[] = []
  const { clock, context } = service.container.runtime
  // Each callback runs inside the cleanup frame, so that a `stop()` or `dispose()` from its synchronous part is found.
  const call = <T>(fn: () => T | Promise<T>): Promise<T> => context.run(frame, () => invokeUser(fn))

  const timeoutMs = timeoutOf(service, 'stop')
  const deadline = timeoutMs === undefined
    ? undefined
    : timeoutSignal(clock, timeoutMs, () => new HookTimeoutError(`The 'stop' hook of '${service.name}' timed out.`, 'stop', timeoutMs))
  // A `stop` handler sees the timeout on its signal, and the disposal of the instance.
  const hookSignal = anySignal(instance.controller.signal, deadline?.signal)
  let timedOut = false
  /** Waits for one callback until the deadline. `undefined` means that the deadline passed. */
  const settle = async <T>(promise: Promise<T>): Promise<{ readonly value: T } | undefined> => {
    if (!deadline)
      return { value: await promise }
    if (timedOut) {
      promise.catch(() => {})
      return undefined
    }

    const result = await raceAbort(promise, deadline.signal)
    if (result.kind === 'settled')
      return { value: result.value }

    timedOut = true
    service.container.api.logger.warn(stopTimeoutWarning(service, timeoutMs!))
    const decision = decideTimeout(service, instance, 'stop', timeoutMs!)
    recordDecision(service, instance, decision, false)
    finishRun(instance, 'stop', decision)
    if (decision.kind === 'fail')
      errors.push(decision.error)
    return undefined
  }

  if (stopHooks && instance.hooks.stop.length > 0) {
    const logger = loggerOf(service)
    logger?.hookOnStop(service.name)
    const startTime = performance.now()
    for (const handler of [...instance.hooks.stop].reverse()) {
      const settled = await settle(callHandler(service, instance, 'stop', handler, hookSignal, {}, call))
      if (!settled)
        continue

      const decision = settled.value
      recordDecision(service, instance, decision, false)
      finishRun(instance, 'stop', decision)
      if (decision.kind === 'fail')
        errors.push(decision.error)
    }
    logger?.hookOnStopComplete(service.name, performance.now() - startTime)
  }

  const effects = instance.effects.splice(0).reverse()
  for (const disposer of effects) {
    try {
      await settle(call(disposer))
    }
    catch (error) {
      errors.push(error)
    }
  }

  deadline?.cancel()
  return errors
}

export async function teardown(service: ServiceNode, instance: InstanceNode, stopHooks: boolean, phase?: 'stopping'): Promise<void> {
  service.busy = true
  cancelRequeueWait(instance)
  instance.extraHolds.clear()
  if (phase)
    setPhase(service, phase, { reason: service.stopIntent.reason })

  // The frame of the teardown names the service, so that a synchronous `stop()` or `dispose()` from a cleanup is found, also outside a disposal.
  const frame = serviceFrame(service, service.container.frame)
  const errors = await service.container.runtime.context.run(frame, () => runTeardownCallbacks(service, instance, stopHooks, frame))
  frame.active = false

  instance.disposed = true
  instance.controller.abort(new Error(`The instance '${instance.id}' of '${service.name}' was disposed.`))
  service.busy = false

  service.container.runtime.reconciler.notifyTeardown(service, errors)
  batch(() => {
    instance.bindings.clear()
    syncHolds(service, instance)
    // The phase record still names the stopped instance. The instance is cleared after it.
    settleAfterStop(service, errors)
    service.signals.instance(undefined)
  })
}

function settleAfterStop(service: ServiceNode, errors: readonly unknown[]): void {
  const intent = service.stopIntent
  service.stopIntent = {}

  // A new service that did not reach its swap leaves. The old service does not change.
  const { swap } = service
  if (swap) {
    const failure = intent.failure ?? (errors.length > 0 ? { error: errors[0] } : undefined)
    service.swap = undefined
    if (failure) {
      service.failure = failure
      setPhase(service, 'failed', { reason: intent.reason ?? 'The replacement failed. The old instance stays.', decision: intent.decision })
      swap.settle({ kind: 'failed', error: failure.error })
    }
    else {
      swap.settle(service.signals.active() ? { kind: 'cancelled' } : { kind: 'stopping' })
    }
    service.signals.present(false)
    service.teardownErrors.push(...errors)
    finalize(service)
    return
  }

  if (!service.signals.present()) {
    service.teardownErrors.push(...errors)
    finalize(service)
    return
  }
  if (intent.failure || errors.length > 0) {
    service.failure = intent.failure ?? { error: errors[0] }
    setPhase(service, 'failed', { reason: intent.reason, decision: intent.decision })
    return
  }

  service.parkedEpoch = intent.parkEpoch
  setPhase(service, 'pending', { reason: intent.reason, decision: intent.decision })
  service.container.runtime.reconciler.markDirty(service)
}

export function finalize(service: ServiceNode): void {
  const { swap, template } = service
  service.swap = undefined
  swap?.settle({ kind: 'cancelled' })
  service.disposeEffects()
  service.container.services.delete(service)
  batch(() => {
    removeDeclaration(service)
    if (template) {
      const consumers = template.signals.consumers()
      if (consumers.get(service.container) === service)
        template.signals.consumers(new Map([...consumers].filter(([, consumer]) => consumer !== service)))
    }
    setPhase(service, 'withdrawn')
  })
  service.withdrawal.resolve([...service.teardownErrors])
  // A withdrawn `perConsumer` registration finalizes after its last consumer service.
  if (template)
    service.container.runtime.reconciler.markDirty(template)
  // The effect is gone, so no phase change requests a drain. Request one for the drained listeners.
  service.container.runtime.reconciler.requestDrain()
}
