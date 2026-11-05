import type { Reconciler, ServiceNode } from '../graph/graph'
import type { CleanupContext } from '../helpers/cleanup-context'

import { buildLost } from '../graph/resolvers/resolvers'
import { untracked } from '../helpers/signals'
import { reconcilePending } from './build'
import { callListeners } from './calls'
import { reconcileConflict } from './conflict'
import { reconcileRunning } from './dependency-hooks'
import { reconcileRegistration } from './registration'
import { reconcileRetrying } from './retry'
import { finalize, reconcileStopping } from './stop'
import { checkSwap } from './swap'

export interface ReconcilerOptions {
  /** The cleanup context of the runtime. A drain starts outside all of its frames. */
  readonly context: CleanupContext
}

/**
 * Creates the execution layer.
 *
 * A work queue holds dirty services, each at most once. The reconciler runs one transition at a time for each service.
 * Each transition reads the latest derived values when it starts and when it ends.
 */
export function createReconciler(options: ReconcilerOptions): Reconciler {
  const { context } = options
  const queue = new Set<ServiceNode>()
  const drainedListeners = new Set<() => void>()
  const teardownListeners = new Set<(service: ServiceNode, errors: readonly unknown[]) => void>()
  let drainRequested = false
  let draining = false

  function requestDrain(): void {
    if (drainRequested || draining)
      return

    drainRequested = true
    queueMicrotask(drain)
  }

  function markDirty(service: ServiceNode): void {
    queue.add(service)
    requestDrain()
  }

  function drain(): void {
    drainRequested = false
    // The drain is an entry point. Transitions start outside all cleanup frames. A teardown enters the frame of its container.
    untracked(() => context.run(undefined, () => {
      draining = true
      try {
        for (const service of queue) {
          queue.delete(service)
          reconcile(service)
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

  function reconcile(service: ServiceNode): void {
    // A service of an open transaction belongs to the transaction.
    if (service.transaction)
      return
    const phase = service.signals.phase()
    if (phase === 'withdrawn')
      return
    if (service.perConsumer) {
      reconcileRegistration(service)
      return
    }

    checkSwap(service)

    if (service.busy) {
      // A transition is in progress. Do not interrupt it. Only abort the signal of a superseded build or hook run.
      const instance = service.signals.instance()
      if (!instance)
        return
      if (phase === 'building') {
        if (buildLost(service, instance))
          instance.controller.abort(new Error(`The build of '${service.name}' was superseded.`))
      }
      else if (instance.hookRun && service.signals.targetLost()) {
        instance.hookRun.abort(new Error(`A newer target superseded the hook run of '${service.name}'.`))
      }
      return
    }

    switch (phase) {
      case 'pending':
        reconcilePending(service)
        return
      case 'conflict':
        reconcileConflict(service)
        return
      case 'failed':
        if (!service.signals.present())
          finalize(service)
        return
      case 'running':
        reconcileRunning(service)
        return
      case 'retrying':
        reconcileRetrying(service)
        return
      case 'stopping':
        reconcileStopping(service)
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
    notifyTeardown: (service, errors) => callListeners(teardownListeners, service, errors),
    requestDrain,
  }
}
