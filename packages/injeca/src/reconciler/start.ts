import type { InstanceNode, ServiceNode } from '../graph/graph'
import type { Decision } from '../primitives/decision'

import { HookTimeoutError } from '../diagnostics/errors'
import { setPhase, timeoutOf } from '../graph/nodes'
import { epochOf } from '../graph/resolvers/resolvers'
import { raceTimeout } from '../helpers/timeout'
import { loggerOf } from './calls'
import { beginHookRun, decideTimeout, finishRun, recordDecision, runHandlers } from './hook-run'
import { exhaustedIntent, scheduleRequeue } from './requeue'
import { enterStopping } from './stop'
import { completeSwap } from './swap'

/**
 * Runs the `start` handlers of one attempt, from `instance.startFrom`, within the configured `start` timeout.
 * At the timeout, the run aborts, later handlers do not run, and the `onTimeout` decision replaces the result. Late decisions are recorded as ignored.
 */
async function runAttempt(service: ServiceNode, instance: InstanceNode): Promise<Decision[]> {
  const run = beginHookRun(instance)
  const progress = { index: instance.startFrom }
  let timedOut = false
  const running = runHandlers(service, instance, 'start', run.signal, {}, { from: instance.startFrom, progress, stopped: () => timedOut })
  const timeoutMs = timeoutOf(service, 'start')
  // Without a timeout, `start` waits until it settles.
  const result = timeoutMs === undefined
    ? { kind: 'settled' as const, value: await running }
    : await raceTimeout(service.container.runtime.clock, running, timeoutMs)
  instance.startFrom = progress.index

  if (result.kind === 'settled') {
    run.end()
    return result.value
  }

  timedOut = true
  run.abort(new HookTimeoutError(`The 'start' hook of '${service.name}' timed out.`, 'start', timeoutMs!))
  run.end()
  void running.then((late) => {
    for (const decision of late)
      recordDecision(service, instance, decision, true)
  })
  return [decideTimeout(service, instance, 'start', timeoutMs!)]
}

/**
 * Runs the `start` hooks of a built instance. The service moves to `running`, waits in `retrying` for a requeue, or stops.
 *
 * A requeue keeps the instance and its bindings. The next attempt runs the requeued handler again, then the later ones. `build` does not run again.
 */
export async function runStart(service: ServiceNode, instance: InstanceNode): Promise<void> {
  service.busy = true
  const handlers = instance.hooks.start
  const logger = handlers.length > 0 ? loggerOf(service) : undefined
  if (instance.startFrom === 0)
    logger?.hookOnStart(service.name)
  const startTime = performance.now()

  const decisions = handlers.length > instance.startFrom ? await runAttempt(service, instance) : []
  service.busy = false

  const ignored = service.signals.targetLost()
  for (const decision of decisions)
    recordDecision(service, instance, decision, ignored)
  if (ignored) {
    enterStopping(service, { reason: 'A newer target superseded the start.' })
    return
  }

  const decision = decisions.at(-1)
  if (!decision || decision.kind === 'handled') {
    if (decision)
      finishRun(instance, 'start', decision)
    logger?.hookOnStartComplete(service.name, performance.now() - startTime)
    // A dependency that changed during the start is a change for the running service.
    // A new service of a replacement swaps in only now, so the old instance serves until here.
    if (service.swap)
      completeSwap(service)
    else
      setPhase(service, 'running')
    return
  }

  finishRun(instance, 'start', decision)
  switch (decision.kind) {
    case 'stop':
      enterStopping(service, { parkEpoch: epochOf(service, edge => instance.bindings.get(edge.name)), reason: decision.reason, decision: 'stop' })
      return
    case 'fail':
      enterStopping(service, { failure: { error: decision.error }, reason: decision.reason, decision: 'fail' })
      return
    case 'requeue': {
      const exhausted = exhaustedIntent(service, decision)
      if (exhausted) {
        enterStopping(service, exhausted)
        return
      }
      // The service keeps its instance and holds its dependencies. It is not available until a later attempt completes.
      setPhase(service, 'retrying', { reason: decision.reason, decision: 'requeue' })
      scheduleRequeue(service, instance, decision)
    }
  }
}
