import type { ContainerNode, Observer, UnitNode } from '../graph/graph'
import type { Container, ObserveRecord } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { assertActive, nodeOf } from '../graph/nodes'
import { reportCallbackError } from '../graph/observers'
import { statusFields } from '../graph/status'
import { untracked } from '../helpers/signals'

function replayOf(unit: UnitNode): ObserveRecord[] {
  const owner = unit.container.owner
  const instanceId = unit.signals.instance()?.id
  const records: ObserveRecord[] = [{ type: 'phase', key: unit.name, owner, instanceId, from: undefined, to: unit.signals.phase() }]
  const status = unit.signals.effective()
  if (status)
    records.push({ type: 'status', key: unit.name, owner, instanceId, from: undefined, to: status.status, ...statusFields(status) })

  return records
}

function subtree(container: ContainerNode): ContainerNode[] {
  return [container, ...[...container.children].flatMap(subtree)]
}

/**
 * Subscribes to all transitions of the units in `container` and in its child containers.
 *
 * It replays the current state of each unit at once, then sends each change in order.
 * A callback error goes to the other observers as an `error` record. No call follows the disposal of the container.
 * Returns a disposer.
 */
export function observe(container: Container, callback: (record: ObserveRecord) => void): () => void {
  const node = nodeOf(container)
  assertActive(node, 'observe')
  if (typeof callback !== 'function')
    throw new InvalidArgumentError('The observe callback is not a function.')

  const { deliveries, observers } = node.runtime
  const observer: Observer = { container: node, callback, active: true }
  const replay = untracked(() => subtree(node)
    .flatMap(current => [...current.units])
    .filter(unit => unit.kind !== 'resolver' && unit.signals.present())
    .flatMap(replayOf))

  observers.add(observer)
  const stop = (): void => {
    observer.active = false
    observers.delete(observer)
    node.disposedListeners.delete(stop)
  }
  node.disposedListeners.add(stop)

  deliveries.deliver(replay.map(entry => ({
    run: () => {
      if (observer.active)
        callback(Object.freeze(entry))
    },
    onError: (error: unknown) => reportCallbackError(node, entry.key, error, 'An observe callback threw.', observer),
  })))

  return stop
}
