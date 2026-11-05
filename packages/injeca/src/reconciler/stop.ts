import type { InstanceNode, ServiceNode, StopIntent } from '../graph/graph'
import type { CleanupFrame } from '../helpers/cleanup-context'

import { setPhase } from '../graph/nodes'
import { batch } from '../helpers/signals'
import { invokeUser, loggerOf } from './calls'
import { syncHolds } from './holds'
import { callHandler, finishRun, recordDecision } from './hook-run'
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

async function runTeardownCallbacks(service: ServiceNode, instance: InstanceNode, stopHooks: boolean, frame: CleanupFrame | undefined): Promise<unknown[]> {
  const errors: unknown[] = []
  // Each callback runs inside the cleanup frame, so that a re-entrant dispose from it is detected.
  const call = <T>(fn: () => T | Promise<T>): Promise<T> => service.container.runtime.context.run(frame, () => invokeUser(fn))

  if (stopHooks && instance.hooks.stop.length > 0) {
    const logger = loggerOf(service)
    logger?.hookOnStop(service.name)
    const startTime = performance.now()
    for (const handler of [...instance.hooks.stop].reverse()) {
      const decision = await callHandler(service, instance, 'stop', handler, instance.controller.signal, {}, call)
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
      await call(disposer)
    }
    catch (error) {
      errors.push(error)
    }
  }

  return errors
}

export async function teardown(service: ServiceNode, instance: InstanceNode, stopHooks: boolean, phase?: 'stopping'): Promise<void> {
  service.busy = true
  cancelRequeueWait(instance)
  instance.extraHolds.clear()
  if (phase)
    setPhase(service, phase, { reason: service.stopIntent.reason })

  const frame = service.container.frame
  const errors = await service.container.runtime.context.run(frame, () => runTeardownCallbacks(service, instance, stopHooks, frame))

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
  service.disposeEffects()
  service.container.services.delete(service)
  setPhase(service, 'withdrawn')
  service.withdrawal.resolve([...service.teardownErrors])
  // The effect is gone, so no phase change requests a drain. Request one for the drained listeners.
  service.container.runtime.reconciler.requestDrain()
}
