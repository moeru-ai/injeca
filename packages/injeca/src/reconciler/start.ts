import type { InstanceNode, ServiceNode } from '../graph/graph'
import type { Decision } from '../primitives/decision'

import { setPhase } from '../graph/nodes'
import { epochOf } from '../graph/resolvers/resolvers'
import { loggerOf } from './calls'
import { beginHookRun, finishRun, recordDecision, runHandlers } from './hook-run'
import { enterStopping } from './stop'

/** Runs the `start` hooks of a built instance. The service moves to `running`, or it stops. */
export async function runStart(service: ServiceNode, instance: InstanceNode): Promise<void> {
  service.busy = true
  const handlers = instance.hooks.start
  const logger = handlers.length > 0 ? loggerOf(service) : undefined
  logger?.hookOnStart(service.name)
  const startTime = performance.now()

  let decisions: Decision[] = []
  if (handlers.length > 0) {
    const run = beginHookRun(instance)
    decisions = await runHandlers(service, instance, 'start', run.signal, {})
    run.end()
  }
  service.busy = false

  const ignored = service.signals.targetLost()
  for (const decision of decisions)
    recordDecision(service, instance, decision, ignored)
  if (ignored) {
    enterStopping(service, { reason: 'A newer target superseded the start.' })
    return
  }

  const decision = decisions.at(-1)
  if (decision)
    finishRun(instance, 'start', decision)

  switch (decision?.kind ?? 'handled') {
    case 'handled':
      logger?.hookOnStartComplete(service.name, performance.now() - startTime)
      // A dependency that changed during the start is a change for the running service.
      setPhase(service, 'running')
      return
    case 'stop':
      enterStopping(service, { parkEpoch: epochOf(service, edge => instance.bindings.get(edge.name)), reason: decision?.reason, decision: 'stop' })
      return
    case 'fail':
      enterStopping(service, { failure: { error: decision?.kind === 'fail' ? decision.error : undefined }, reason: decision?.reason, decision: 'fail' })
      return
    default:
      // NOTICE:
      // `requeue` is valid for `start`, but `start` retries come in design step 4. Until then, the service fails.
      // Source: docs/design-0.3.md, "Delivery" step 4 and "Requeue".
      // Removal condition: step 4 implements the `start` requeue and the `retrying` phase.
      enterStopping(service, { failure: { error: new Error(`The start hook of '${service.name}' returned 'requeue'. This version does not support it yet.`) }, decision: 'requeue' })
  }
}
