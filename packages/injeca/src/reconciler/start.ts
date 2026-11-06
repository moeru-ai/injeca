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

/** The decisions of one attempt. `superseded` is `true` when a newer target aborted the run and injeca stopped waiting for it. */
interface AttemptResult {
  readonly decisions: readonly Decision[]
  readonly superseded: boolean
}

/** Resolves when `signal` aborts. Returns a function that removes the listener. */
function onAbort(signal: AbortSignal): { readonly aborted: Promise<void>, readonly remove: () => void } {
  let remove = () => {}
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const listener = () => resolve()
    signal.addEventListener('abort', listener, { once: true })
    remove = () => signal.removeEventListener('abort', listener)
  })

  return { aborted, remove }
}

/**
 * Runs the `start` handlers of one attempt, from `instance.startFrom`, within the configured `start` timeout.
 *
 * At the timeout, the run aborts, later handlers do not run, and the `onTimeout` decision replaces the result.
 * When a newer target aborts the run, for example `stop()` or `dispose()`, injeca does not wait for the handler in progress. The service stops at once.
 * Late decisions are recorded as ignored.
 */
async function runAttempt(service: ServiceNode, instance: InstanceNode): Promise<AttemptResult> {
  const run = beginHookRun(instance)
  const progress = { index: instance.startFrom }
  let abandoned = false
  const running = runHandlers(service, instance, 'start', run.signal, {}, { from: instance.startFrom, progress, stopped: () => abandoned })
  const abort = onAbort(run.signal)
  const raced = Promise.race([
    running.then(value => ({ kind: 'settled' as const, value })),
    abort.aborted.then(() => ({ kind: 'superseded' as const })),
  ])
  const timeoutMs = timeoutOf(service, 'start')
  // Without a timeout, `start` waits until it settles or a newer target aborts it.
  const timed = timeoutMs === undefined
    ? { kind: 'settled' as const, value: await raced }
    : await raceTimeout(service.container.runtime.clock, raced, timeoutMs)
  abort.remove()
  instance.startFrom = progress.index

  if (timed.kind === 'settled' && timed.value.kind === 'settled') {
    run.end()
    return { decisions: timed.value.value, superseded: false }
  }

  abandoned = true
  const recordLate = (): void => {
    void running.then((late) => {
      for (const decision of late)
        recordDecision(service, instance, decision, true)
    })
  }
  if (timed.kind === 'settled') {
    // A newer target aborted the run. The handler in progress can still return. Its decision is ignored.
    run.end()
    recordLate()
    return { decisions: [], superseded: true }
  }

  run.abort(new HookTimeoutError(`The 'start' hook of '${service.name}' timed out.`, 'start', timeoutMs!))
  run.end()
  recordLate()
  return { decisions: [decideTimeout(service, instance, 'start', timeoutMs!)], superseded: false }
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

  const attempt = handlers.length > instance.startFrom ? await runAttempt(service, instance) : { decisions: [], superseded: false }
  const { decisions } = attempt
  service.busy = false

  const ignored = attempt.superseded || service.signals.targetLost()
  for (const decision of decisions)
    recordDecision(service, instance, decision, ignored)
  if (ignored) {
    enterStopping(service, { reason: 'A newer target superseded the start.' })
    return
  }

  const decision = decisions.at(-1)
  if (!decision || decision.kind === 'handled') {
    // A later failure of a consumer service builds again for each demander.
    service.demanders.clear()
    if (decision)
      finishRun(instance, 'start', decision)
    logger?.hookOnStartComplete(service.name, performance.now() - startTime)
    // A dependency that changed during the start is a change for the running service.
    // A new service of a replacement swaps in only now, so the old instance serves until here.
    if (service.swap?.ready) {
      // A consumer service of a `perConsumer` replacement waits until each consumer service completes `start`.
      service.swap.held = true
      service.swap.ready(service)
    }
    else if (service.swap) {
      completeSwap(service)
    }
    else {
      setPhase(service, 'running')
    }
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
