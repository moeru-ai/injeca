import type { ErrorObserveRecord, ObserveRecord, TimeoutObserveRecord, WaitAbortedObserveRecord } from '../types'
import type { ContainerNode, Observer, UnitNode } from './graph'

import { messageOf } from '../helpers/error-from'

function within(container: ContainerNode, ancestor: ContainerNode): boolean {
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    if (current === ancestor)
      return true
  }

  return false
}

/** The active observers of `container`: the observers of the container and of its ancestors. */
function targetsOf(container: ContainerNode, source?: Observer): Observer[] {
  return [...container.runtime.observers].filter(observer => observer !== source && observer.active && within(container, observer.container))
}

function send(container: ContainerNode, targets: readonly Observer[], record: ObserveRecord): void {
  container.runtime.deliveries.deliver(targets.map(observer => ({
    run: () => {
      if (observer.active && observer.container.state !== 'disposed')
        observer.callback(record)
    },
    onError: (error: unknown) => {
      // An error about an error record is dropped. Else a failing observer can loop forever.
      if (record.type !== 'error')
        reportCallbackError(observer.container, record.key, error, 'An observe callback threw.', observer)
    },
  })))
}

/** Sends `record` to the observers of `container`. */
export function emitRecord(container: ContainerNode, record: ObserveRecord): void {
  // The targets are fixed now. An observer that subscribes later gets its replay, not this record.
  const targets = targetsOf(container)
  if (targets.length === 0)
    return

  send(container, targets, Object.freeze(record))
}

/** Reports a callback error as an `error` record. An error from an observe callback does not go back to that callback. */
export function reportCallbackError(container: ContainerNode, key: string, error: unknown, reason: string, source?: Observer): void {
  const record: ErrorObserveRecord = { type: 'error', key, owner: container.owner, instanceId: undefined, reason, error }
  send(container, targetsOf(container, source), record)
}

/** Sends a `wait-aborted` record for each unit of `units`: the `signal` of `call` aborted before the unit stopped. */
export function recordAbortedWait(units: readonly UnitNode[], call: WaitAbortedObserveRecord['call'], reason: unknown): void {
  const message = messageOf(reason)
  for (const unit of units) {
    emitRecord(unit.container, {
      type: 'wait-aborted',
      key: unit.name,
      owner: unit.container.owner,
      instanceId: unit.signals.instance()?.id,
      call,
      phase: unit.signals.phase(),
      reason: message,
      abortReason: reason,
    })
  }
}

/** Sends a `timeout` record. A timeout of container effects has `key: ''`, no instance, and attempt 1. */
export function recordTimeout(container: ContainerNode, record: Omit<TimeoutObserveRecord, 'type' | 'owner'>): void {
  emitRecord(container, { type: 'timeout', key: record.key, owner: container.owner, instanceId: record.instanceId, hook: record.hook, timeoutMs: record.timeoutMs, attempt: record.attempt, reason: record.reason })
}
