import type { InstanceNode, UnitNode } from '../graph/graph'
import type { Decision } from '../primitives/decision'

import { HookTimeoutError } from '../diagnostics/errors'
import { setPhase, timeoutOf } from '../graph/nodes'
import { epochOf } from '../graph/resolvers/resolvers'
import { raceAbort, timeoutSignal } from '../helpers/abort'
import { loggerOf } from './calls'
import { beginHookRun, decideTimeout, finishRun, recordDecision, recordLateDecision, runHandlers } from './hook-run'
import { exhaustedIntent, scheduleRequeue } from './requeue'
import { enterStopping } from './stop'
import { completeSwap } from './swap'

/** The decisions of one attempt. `superseded` is `true` when a newer target aborted the run and injeca stopped waiting for it. */
interface AttemptResult {
  readonly decisions: readonly Decision[]
  readonly superseded: boolean
}

/**
 * Runs the `start` handlers of one attempt, from `instance.startFrom`, within the configured `start` timeout.
 *
 * The run signal includes a timeout signal on the container clock. At the timeout, the run signal aborts with `hook-timeout`, later handlers do not run, and the `onTimeout` decision replaces the result.
 * When a newer target aborts the run, for example `stop()` or `dispose()`, injeca does not wait for the handler in progress. The unit stops at once.
 * Late decisions are recorded as ignored.
 */
async function runAttempt(unit: UnitNode, instance: InstanceNode): Promise<AttemptResult> {
  const timeoutMs = timeoutOf(unit, 'start')
  const timer = timeoutMs === undefined
    ? undefined
    : timeoutSignal(unit.container.runtime.clock, timeoutMs, () => new HookTimeoutError(`The 'start' hook of '${unit.name}' timed out.`, 'start', timeoutMs))
  const run = beginHookRun(instance, timer?.signal)
  const progress = { index: instance.startFrom }
  let abandoned = false
  const running = runHandlers(unit, instance, 'start', run.signal, {}, { from: instance.startFrom, progress, stopped: () => abandoned })
  // Without a timeout, `start` waits until it settles or a newer target aborts it.
  const result = await raceAbort(running, run.signal)
  timer?.cancel()
  const timedOut = timer !== undefined && timer.signal.aborted && run.signal.reason === timer.signal.reason
  run.end()
  instance.startFrom = progress.index

  if (result.kind === 'settled')
    return { decisions: result.value, superseded: false }

  abandoned = true
  // The handler in progress can still return. Its decision is ignored. A late failure is reported, unless it is the abort of the run.
  void running.then((late) => {
    for (const decision of late)
      recordLateDecision(unit, instance, decision, [run.signal])
  })
  if (!timedOut)
    return { decisions: [], superseded: true }

  return { decisions: [decideTimeout(unit, instance, 'start', timeoutMs!)], superseded: false }
}

/**
 * Runs the `start` hooks of a built instance. The unit moves to `running`, waits in `retrying` for a requeue, or stops.
 *
 * A requeue keeps the instance and its bindings. The next attempt runs the requeued handler again, then the later ones. `build` does not run again.
 */
export async function runStart(unit: UnitNode, instance: InstanceNode): Promise<void> {
  unit.busy = true
  const handlers = instance.hooks.start
  const logger = handlers.length > 0 ? loggerOf(unit) : undefined
  if (instance.startFrom === 0)
    logger?.hookOnStart(unit.name)
  const startTime = performance.now()

  const attempt = handlers.length > instance.startFrom ? await runAttempt(unit, instance) : { decisions: [], superseded: false }
  const { decisions } = attempt
  unit.busy = false

  const ignored = attempt.superseded || unit.signals.targetLost()
  for (const decision of decisions)
    recordDecision(unit, instance, decision, ignored)
  if (ignored) {
    enterStopping(unit, { reason: 'A newer target superseded the start.' })
    return
  }

  const decision = decisions.at(-1)
  if (!decision || decision.kind === 'handled') {
    // A later failure of a consumer unit builds again for each demander.
    unit.demanders.clear()
    if (decision)
      finishRun(instance, 'start', decision)
    logger?.hookOnStartComplete(unit.name, performance.now() - startTime)
    // A dependency that changed during the start is a change for the running unit.
    // A new unit of a replacement swaps in only now, so the old instance serves until here.
    if (unit.swap?.ready) {
      // A consumer unit of a per-container replacement waits until each consumer unit completes `start`.
      unit.swap.held = true
      unit.swap.ready(unit)
    }
    else if (unit.swap) {
      completeSwap(unit)
    }
    else {
      setPhase(unit, 'running')
    }
    return
  }

  finishRun(instance, 'start', decision)
  switch (decision.kind) {
    case 'stop':
      enterStopping(unit, { parkEpoch: epochOf(unit, edge => instance.bindings.get(edge.name)), reason: decision.reason, decision: 'stop' })
      return
    case 'fail':
      enterStopping(unit, { failure: { error: decision.error }, reason: decision.reason, decision: 'fail' })
      return
    case 'requeue': {
      const exhausted = exhaustedIntent(unit, decision)
      if (exhausted) {
        enterStopping(unit, exhausted)
        return
      }
      // The unit keeps its instance and holds its dependencies. It is not available until a later attempt completes.
      setPhase(unit, 'retrying', { reason: decision.reason, decision: 'requeue' })
      scheduleRequeue(unit, instance, decision)
    }
  }
}
