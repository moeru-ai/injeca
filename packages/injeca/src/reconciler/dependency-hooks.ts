import type { InstanceNode, UnitNode } from '../graph/graph'
import type { UnitHook } from '../primitives/decision'
import type { DependencyChange } from '../types'
import type { Snapshot } from './snapshot'

import { inConflict } from '../graph/resolvers/exclusive'
import { epochOf, requiredWithdrawn } from '../graph/resolvers/resolvers'
import { batch } from '../helpers/signals'
import { demandProviders } from './demand'
import { releaseExtraHolds, syncHolds } from './holds'
import { beginHookRun, finishRun, recordDecision, runHandlers } from './hook-run'
import { rebuild } from './rebuild'
import { cancelRequeueWait, exhaustedIntent, scheduleRequeue } from './requeue'
import { acceptSnapshot, currentSnapshot, describeChanges, diffSnapshot, hookDependsOn, isIdentityChange } from './snapshot'
import { enterStopping } from './stop'

/** Handles a running unit: it stops it, or it runs a dependency hook for the changes since the last handled snapshot. */
export function reconcileRunning(unit: UnitNode): void {
  const instance = unit.signals.instance()
  if (!instance) {
    enterStopping(unit, {})
    return
  }
  if (!unit.signals.present() || !unit.signals.active()) {
    cancelRequeueWait(instance)
    enterStopping(unit, { reason: unit.signals.present() ? 'The container stopped.' : unit.replacedBy ? 'The unit was replaced.' : 'The unit was withdrawn.' })
    return
  }
  if (inConflict(unit)) {
    cancelRequeueWait(instance)
    enterStopping(unit, { reason: `The exclusive key '${unit.name}' got another declaration.` })
    return
  }

  // An optional or a fallback edge to a key that registers after this unit demands its provider now.
  demandProviders(unit)
  const snapshot = currentSnapshot(unit)
  // A required dependency is withdrawn. The unit stops, also during a requeue wait. A handler gets a notice only.
  if (requiredWithdrawn(unit)) {
    cancelRequeueWait(instance)
    if (instance.hooks['dependency-change'].length > 0)
      void runNotice(unit, instance, snapshot)
    else
      enterStopping(unit, { reason: 'A required dependency was withdrawn.' })
    return
  }

  // The successor of a make-before-break rebuild builds. The old instance serves unchanged until the swap.
  if (unit.successor?.swap?.rebuild)
    return

  const changes = diffSnapshot(unit, instance.handled, snapshot)
  // A waiting requeue merges the new changes. Its run reads the latest snapshot.
  if (changes.length === 0 || instance.requeueWait)
    return

  const identity = changes.some(isIdentityChange)
  const hook: UnitHook = identity ? 'dependency-change' : 'dependency-status-change'
  if (instance.hooks[hook].length === 0) {
    if (identity)
      rebuild(unit, instance, { reason: `A dependency changed without a handler: ${describeChanges(changes)}.`, decision: 'rebuild' })
    else
      acceptSnapshot(unit, instance, snapshot)
    return
  }

  void runDependencyHook(unit, instance, hook, snapshot, changes)
}

/** Calls `dependency-change` as a notice before the unit stops for a withdrawn required dependency. The decisions are ignored. */
async function runNotice(unit: UnitNode, instance: InstanceNode, snapshot: Snapshot): Promise<void> {
  unit.busy = true
  const changes = diffSnapshot(unit, instance.handled, snapshot)
  // The withdrawn provider waits for this holder, so its bound value is still usable during the notice.
  const view = new Map(snapshot)
  for (const [name, binding] of instance.bindings) {
    if (!view.get(name))
      view.set(name, { state: Object.freeze({ provider: binding.unit.name, instanceId: binding.id, status: 'unavailable' }), instance: binding })
  }

  const decisions = await runHandlers(unit, instance, 'dependency-change', instance.controller.signal, {
    dependsOn: hookDependsOn(unit, view),
    changes: Object.freeze(changes),
  }, { all: true })
  unit.busy = false

  for (const decision of decisions)
    recordDecision(unit, instance, decision, true)
  enterStopping(unit, { reason: `A required dependency was withdrawn: ${describeChanges(changes)}.` })
}

async function runDependencyHook(unit: UnitNode, instance: InstanceNode, hook: UnitHook, snapshot: Snapshot, changes: readonly DependencyChange[]): Promise<void> {
  unit.busy = true
  // The handler can use the new instances, so the run holds them until it ends.
  for (const entry of snapshot.values()) {
    if (entry)
      instance.extraHolds.add(entry.instance)
  }
  batch(() => syncHolds(unit, instance))

  const run = beginHookRun(instance)
  const decisions = await runHandlers(unit, instance, hook, run.signal, {
    dependsOn: hookDependsOn(unit, snapshot),
    changes: Object.freeze([...changes]),
  })
  run.end()
  unit.busy = false

  const ignored = unit.signals.targetLost()
  for (const decision of decisions)
    recordDecision(unit, instance, decision, ignored)
  if (ignored) {
    releaseExtraHolds(unit, instance)
    unit.container.runtime.reconciler.markDirty(unit)
    return
  }

  const decision = decisions.at(-1)!
  finishRun(instance, hook, decision)
  switch (decision.kind) {
    case 'handled':
      acceptSnapshot(unit, instance, snapshot)
      // Changes that arrived during the run are not handled yet.
      unit.container.runtime.reconciler.markDirty(unit)
      return
    case 'requeue': {
      releaseExtraHolds(unit, instance)
      const exhausted = exhaustedIntent(unit, decision)
      if (exhausted)
        enterStopping(unit, exhausted)
      else
        scheduleRequeue(unit, instance, decision)
      return
    }
    case 'rebuild':
      releaseExtraHolds(unit, instance)
      rebuild(unit, instance, { reason: decision.reason, decision: 'rebuild' })
      return
    case 'stop':
      releaseExtraHolds(unit, instance)
      enterStopping(unit, { parkEpoch: epochOf(unit, edge => snapshot.get(edge.name)?.instance), reason: decision.reason, decision: 'stop' })
      return
    case 'fail':
      releaseExtraHolds(unit, instance)
      enterStopping(unit, { failure: { error: decision.error }, reason: decision.reason, decision: 'fail' })
  }
}
