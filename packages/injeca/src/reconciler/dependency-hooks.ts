import type { InstanceNode, ServiceNode } from '../graph/graph'
import type { ServiceHook } from '../primitives/decision'
import type { DependencyChange } from '../types'
import type { Snapshot } from './snapshot'

import { inConflict } from '../graph/resolvers/exclusive'
import { epochOf, requiredWithdrawn } from '../graph/resolvers/resolvers'
import { batch } from '../helpers/signals'
import { demandProviders } from './demand'
import { releaseExtraHolds, syncHolds } from './holds'
import { beginHookRun, finishRun, recordDecision, runHandlers } from './hook-run'
import { cancelRequeueWait, exhaustedIntent, scheduleRequeue } from './requeue'
import { acceptSnapshot, currentSnapshot, describeChanges, diffSnapshot, hookDependsOn, isIdentityChange } from './snapshot'
import { enterStopping } from './stop'

/** Handles a running service: it stops it, or it runs a dependency hook for the changes since the last handled snapshot. */
export function reconcileRunning(service: ServiceNode): void {
  const instance = service.signals.instance()
  if (!instance) {
    enterStopping(service, {})
    return
  }
  if (!service.signals.present() || !service.signals.active()) {
    cancelRequeueWait(instance)
    enterStopping(service, { reason: service.signals.present() ? 'The container stopped.' : service.replacedBy ? 'The service was replaced.' : 'The service was withdrawn.' })
    return
  }
  if (inConflict(service)) {
    cancelRequeueWait(instance)
    enterStopping(service, { reason: `The exclusive key '${service.name}' got another declaration.` })
    return
  }

  // An optional or a fallback edge to a key that registers after this service demands its provider now.
  demandProviders(service)
  const snapshot = currentSnapshot(service)
  // A required dependency is withdrawn. The service stops, also during a requeue wait. A handler gets a notice only.
  if (requiredWithdrawn(service)) {
    cancelRequeueWait(instance)
    if (instance.hooks['dependency-change'].length > 0)
      void runNotice(service, instance, snapshot)
    else
      enterStopping(service, { reason: 'A required dependency was withdrawn.' })
    return
  }

  const changes = diffSnapshot(service, instance.handled, snapshot)
  // A waiting requeue merges the new changes. Its run reads the latest snapshot.
  if (changes.length === 0 || instance.requeueWait)
    return

  const identity = changes.some(isIdentityChange)
  const hook: ServiceHook = identity ? 'dependency-change' : 'dependency-status-change'
  if (instance.hooks[hook].length === 0) {
    if (identity)
      enterStopping(service, { reason: `A dependency changed without a handler: ${describeChanges(changes)}.`, decision: 'rebuild' })
    else
      acceptSnapshot(service, instance, snapshot)
    return
  }

  void runDependencyHook(service, instance, hook, snapshot, changes)
}

/** Calls `dependency-change` as a notice before the service stops for a withdrawn required dependency. The decisions are ignored. */
async function runNotice(service: ServiceNode, instance: InstanceNode, snapshot: Snapshot): Promise<void> {
  service.busy = true
  const changes = diffSnapshot(service, instance.handled, snapshot)
  // The withdrawn provider waits for this holder, so its bound value is still usable during the notice.
  const view = new Map(snapshot)
  for (const [name, binding] of instance.bindings) {
    if (!view.get(name))
      view.set(name, { state: Object.freeze({ provider: binding.service.name, instanceId: binding.id, status: 'unavailable' }), instance: binding })
  }

  const decisions = await runHandlers(service, instance, 'dependency-change', instance.controller.signal, {
    dependsOn: hookDependsOn(service, view),
    changes: Object.freeze(changes),
  }, { all: true })
  service.busy = false

  for (const decision of decisions)
    recordDecision(service, instance, decision, true)
  enterStopping(service, { reason: `A required dependency was withdrawn: ${describeChanges(changes)}.` })
}

async function runDependencyHook(service: ServiceNode, instance: InstanceNode, hook: ServiceHook, snapshot: Snapshot, changes: readonly DependencyChange[]): Promise<void> {
  service.busy = true
  // The handler can use the new instances, so the run holds them until it ends.
  for (const entry of snapshot.values()) {
    if (entry)
      instance.extraHolds.add(entry.instance)
  }
  batch(() => syncHolds(service, instance))

  const run = beginHookRun(instance)
  const decisions = await runHandlers(service, instance, hook, run.signal, {
    dependsOn: hookDependsOn(service, snapshot),
    changes: Object.freeze([...changes]),
  })
  run.end()
  service.busy = false

  const ignored = service.signals.targetLost()
  for (const decision of decisions)
    recordDecision(service, instance, decision, ignored)
  if (ignored) {
    releaseExtraHolds(service, instance)
    service.container.runtime.reconciler.markDirty(service)
    return
  }

  const decision = decisions.at(-1)!
  finishRun(instance, hook, decision)
  switch (decision.kind) {
    case 'handled':
      acceptSnapshot(service, instance, snapshot)
      // Changes that arrived during the run are not handled yet.
      service.container.runtime.reconciler.markDirty(service)
      return
    case 'requeue': {
      releaseExtraHolds(service, instance)
      const exhausted = exhaustedIntent(service, decision)
      if (exhausted)
        enterStopping(service, exhausted)
      else
        scheduleRequeue(service, instance, decision)
      return
    }
    case 'rebuild':
      releaseExtraHolds(service, instance)
      enterStopping(service, { reason: decision.reason, decision: 'rebuild' })
      return
    case 'stop':
      releaseExtraHolds(service, instance)
      enterStopping(service, { parkEpoch: epochOf(service, edge => snapshot.get(edge.name)?.instance), reason: decision.reason, decision: 'stop' })
      return
    case 'fail':
      releaseExtraHolds(service, instance)
      enterStopping(service, { failure: { error: decision.error }, reason: decision.reason, decision: 'fail' })
  }
}
