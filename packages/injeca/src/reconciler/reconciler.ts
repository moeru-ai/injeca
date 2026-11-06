import type { Reconciler, UnitNode } from '../graph/graph'
import type { CleanupContext } from '../helpers/cleanup-context'

import { buildLost } from '../graph/resolvers/resolvers'
import { untracked } from '../helpers/signals'
import { reconcilePending } from './build'
import { callListeners } from './calls'
import { reconcileConflict } from './conflict'
import { reconcileRunning } from './dependency-hooks'
import { reconcileRegistration } from './registration'
import { reconcileRetrying } from './retry'
import { enterStopping, finalize, reconcileStopping } from './stop'
import { checkSwap } from './swap'

export interface ReconcilerOptions {
  /** The cleanup context of the runtime. A drain starts outside all of its frames. */
  readonly context: CleanupContext
}

/**
 * Creates the execution layer.
 *
 * A work queue holds dirty units, each at most once. The reconciler runs one transition at a time for each unit.
 * Each transition reads the latest derived values when it starts and when it ends.
 */
export function createReconciler(options: ReconcilerOptions): Reconciler {
  const { context } = options
  const queue = new Set<UnitNode>()
  const drainedListeners = new Set<() => void>()
  const teardownListeners = new Set<(unit: UnitNode, errors: readonly unknown[]) => void>()
  let drainRequested = false
  let draining = false

  function requestDrain(): void {
    if (drainRequested || draining)
      return

    drainRequested = true
    queueMicrotask(drain)
  }

  function markDirty(unit: UnitNode): void {
    queue.add(unit)
    requestDrain()
  }

  function drain(): void {
    drainRequested = false
    // The drain is an entry point. Transitions start outside all cleanup frames. A teardown enters the frame of its container.
    untracked(() => context.run(undefined, () => {
      draining = true
      try {
        for (const unit of queue) {
          queue.delete(unit)
          reconcile(unit)
        }
      }
      finally {
        draining = false
        if (queue.size > 0)
          requestDrain()
        else
          callListeners(drainedListeners)
      }
    }))
  }

  function reconcile(unit: UnitNode): void {
    // A unit of an open transaction belongs to the transaction.
    if (unit.transaction)
      return
    const phase = unit.signals.phase()
    if (phase === 'withdrawn')
      return
    if (unit.instances === 'per-container') {
      reconcileRegistration(unit)
      return
    }

    checkSwap(unit)

    if (unit.busy) {
      // A transition is in progress. Do not interrupt it. Only abort the signal of a superseded build or hook run.
      const instance = unit.signals.instance()
      if (!instance)
        return
      if (phase === 'building') {
        if (buildLost(unit, instance))
          instance.controller.abort(new Error(`The build of '${unit.name}' was superseded.`))
      }
      else if (instance.hookRun && unit.signals.targetLost()) {
        instance.hookRun.abort(new Error(`A newer target superseded the hook run of '${unit.name}'.`))
      }
      return
    }

    switch (phase) {
      case 'pending':
        reconcilePending(unit)
        return
      case 'conflict':
        reconcileConflict(unit)
        return
      case 'failed':
        if (!unit.signals.present())
          finalize(unit)
        return
      case 'starting':
        // A consumer unit that waits for the batch swap of its replacement stops when the replacement is cancelled.
        if (unit.swap?.held && unit.signals.targetLost())
          enterStopping(unit, { reason: 'The replacement was cancelled before the swap.' })
        return
      case 'running':
        reconcileRunning(unit)
        return
      case 'retrying':
        reconcileRetrying(unit)
        return
      case 'stopping':
        reconcileStopping(unit)
    }
  }

  return {
    markDirty,
    onDrained: (listener) => {
      drainedListeners.add(listener)
      return () => drainedListeners.delete(listener)
    },
    onTeardown: (listener) => {
      teardownListeners.add(listener)
      return () => teardownListeners.delete(listener)
    },
    notifyTeardown: (unit, errors) => callListeners(teardownListeners, unit, errors),
    requestDrain,
  }
}
