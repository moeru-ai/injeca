import type { InstanceNode, StopIntent, UnitNode } from '../graph/graph'
import type { CleanupFrame } from '../helpers/cleanup-context'
import type { Decision } from '../primitives/decision'

import { HookTimeoutError } from '../diagnostics/errors'
import { setPhase, timeoutOf } from '../graph/nodes'
import { removeDeclaration } from '../graph/resolvers/exclusive'
import { openDeadline } from '../helpers/deadline'
import { batch } from '../helpers/signals'
import { invokeUser, loggerOf } from './calls'
import { syncHolds } from './holds'
import { callHandler, decideTimeout, finishRun, recordDecision, recordLateDecision, reportLateFailure } from './hook-run'
import { unitFrame } from './reentry'
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

export function enterStopping(unit: UnitNode, intent: StopIntent): void {
  unit.stopIntent = mergeIntent(unit.stopIntent, intent)
  setPhase(unit, 'stopping', { reason: unit.stopIntent.reason, decision: unit.stopIntent.decision })
  unit.container.runtime.reconciler.markDirty(unit)
}

export function reconcileStopping(unit: UnitNode): void {
  const instance = unit.signals.instance()
  if (!instance) {
    settleAfterStop(unit, [])
    return
  }
  // A provider waits until all its holders release it.
  if (instance.signals.holders().size > 0)
    return

  void teardown(unit, instance, true)
}

/** The warning of a `stop` timeout. During a stop or a disposal of the container, it tells the most common cause. */
function stopTimeoutWarning(unit: UnitNode, timeoutMs: number): string {
  const warning = `The cleanups of '${unit.name}' did not settle within the stop timeout of ${timeoutMs}ms. injeca stopped waiting for them, and the stop continues.`
  const { container } = unit
  const action = container.state === 'disposing' ? 'disposing' : container.signals.started() ? undefined : 'stopping'
  if (!action)
    return warning

  return `${warning} The container is ${action}. A cleanup can be waiting for its own container. It must pass its signal to stop() or dispose().`
}

/**
 * Runs the `stop` hooks in reverse order, then the effect disposers in reverse order.
 *
 * A configured `stop` timeout covers all of them. It is a timeout signal on the container clock. The `stop` handlers get it in their `signal`.
 * When it aborts, injeca records it, warns, applies the `onTimeout` decision, and stops waiting. Without `onTimeout`, the timeout counts as `handled`, so the callers of `stop()` and `dispose()` do not fail.
 * The callback in progress is abandoned. The remaining callbacks still run, but injeca does not wait for them. So a cleanup that awaits the disposal of its own container without its signal cannot block that disposal.
 * The late decisions of the abandoned `stop` handlers are recorded as ignored. A late failure of an abandoned callback goes to `logger.warn`, unless it is the abort reason of its signal.
 */
async function runTeardownCallbacks(unit: UnitNode, instance: InstanceNode, stopHooks: boolean, frame: CleanupFrame | undefined): Promise<unknown[]> {
  const { clock, context } = unit.container.runtime
  // Each callback runs inside the cleanup frame, so that a `stop()` or `dispose()` from its synchronous part is found.
  const call = <T>(fn: () => T | Promise<T>): Promise<T> => context.run(frame, () => invokeUser(fn))
  const errors: unknown[] = []
  const finishStop = (decision: Decision): void => {
    recordDecision(unit, instance, decision, false)
    finishRun(instance, 'stop', decision)
    if (decision.kind === 'fail')
      errors.push(decision.error)
  }

  const timeoutMs = timeoutOf(unit, 'stop')
  // A `stop` handler sees the timeout on its signal, and the disposal of the instance.
  const deadline = openDeadline({
    clock,
    ms: timeoutMs,
    reason: () => new HookTimeoutError(`The 'stop' hook of '${unit.name}' timed out.`, 'stop', timeoutMs!),
    sources: [instance.controller.signal],
    onTimeout: () => {
      unit.container.api.logger.warn(stopTimeoutWarning(unit, timeoutMs!))
      finishStop(decideTimeout(unit, instance, 'stop', timeoutMs!))
    },
    onLateFailure: error => reportLateFailure(unit, 'effect', error),
  })
  const hookSignal = deadline.signal!

  if (stopHooks && instance.hooks.stop.length > 0) {
    const logger = loggerOf(unit)
    logger?.hookOnStop(unit.name)
    const startTime = performance.now()
    for (const handler of [...instance.hooks.stop].reverse()) {
      const settled = await deadline.run(callHandler(unit, instance, 'stop', handler, hookSignal, {}, call), late => recordLateDecision(unit, instance, late, [hookSignal, instance.controller.signal]))
      if (settled)
        finishStop(settled.value)
    }
    logger?.hookOnStopComplete(unit.name, performance.now() - startTime)
  }

  for (const disposer of instance.effects.splice(0).reverse()) {
    try {
      await deadline.run(call(disposer))
    }
    catch (error) {
      errors.push(error)
    }
  }

  deadline.end()
  return errors
}

export async function teardown(unit: UnitNode, instance: InstanceNode, stopHooks: boolean, phase?: 'stopping'): Promise<void> {
  unit.busy = true
  instance.tearingDown = true
  cancelRequeueWait(instance)
  instance.extraHolds.clear()
  if (phase)
    setPhase(unit, phase, { reason: unit.stopIntent.reason })

  // The frame of the teardown names the unit, so that a synchronous `stop()` or `dispose()` from a cleanup is found, also outside a disposal.
  const frame = unitFrame(unit, unit.container.frame)
  const errors = await unit.container.runtime.context.run(frame, () => runTeardownCallbacks(unit, instance, stopHooks, frame))
  frame.active = false

  instance.disposed = true
  instance.controller.abort(new Error(`The instance '${instance.id}' of '${unit.name}' was disposed.`))
  unit.busy = false

  unit.container.runtime.reconciler.notifyTeardown(unit, errors)
  batch(() => {
    instance.bindings.clear()
    syncHolds(unit, instance)
    // The phase record still names the stopped instance. The instance is cleared after it.
    settleAfterStop(unit, errors)
    unit.signals.instance(undefined)
  })
}

function settleAfterStop(unit: UnitNode, errors: readonly unknown[]): void {
  const intent = unit.stopIntent
  unit.stopIntent = {}

  // A new unit that did not reach its swap leaves. The old unit does not change.
  const { swap } = unit
  if (swap) {
    const failure = intent.failure ?? (errors.length > 0 ? { error: errors[0] } : undefined)
    unit.swap = undefined
    if (failure) {
      unit.failure = failure
      setPhase(unit, 'failed', { reason: intent.reason ?? 'The replacement failed. The old instance stays.', decision: intent.decision })
      swap.settle({ kind: 'failed', error: failure.error })
    }
    else {
      swap.settle(unit.signals.active() ? { kind: 'cancelled' } : { kind: 'stopping' })
    }
    unit.signals.present(false)
    unit.teardownErrors.push(...errors)
    finalize(unit)
    return
  }

  if (!unit.signals.present()) {
    unit.teardownErrors.push(...errors)
    finalize(unit)
    return
  }
  if (intent.failure || errors.length > 0) {
    unit.failure = intent.failure ?? { error: errors[0] }
    setPhase(unit, 'failed', { reason: intent.reason, decision: intent.decision })
    return
  }

  unit.parkedEpoch = intent.parkEpoch
  setPhase(unit, 'pending', { reason: intent.reason, decision: intent.decision })
  unit.container.runtime.reconciler.markDirty(unit)
}

export function finalize(unit: UnitNode): void {
  const { swap, template } = unit
  unit.swap = undefined
  swap?.settle({ kind: 'cancelled' })
  unit.disposeEffects()
  unit.container.units.delete(unit)
  batch(() => {
    removeDeclaration(unit)
    if (template) {
      const consumers = template.signals.consumers()
      if (consumers.get(unit.container) === unit)
        template.signals.consumers(new Map([...consumers].filter(([, consumer]) => consumer !== unit)))
    }
    setPhase(unit, 'withdrawn')
  })
  unit.withdrawal.resolve([...unit.teardownErrors])
  // A withdrawn per-container registration finalizes after its last consumer unit.
  if (template)
    unit.container.runtime.reconciler.markDirty(template)
  // The effect is gone, so no phase change requests a drain. Request one for the drained listeners.
  unit.container.runtime.reconciler.requestDrain()
}
