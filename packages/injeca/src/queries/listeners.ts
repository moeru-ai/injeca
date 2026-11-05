import type { Container, EventKey, ListenerEntry } from '../types'

import { nodeOf, subtreeOf } from '../graph/nodes'
import { readEventId } from '../primitives/listen'

/**
 * Returns the current listeners for `eventKey` in `container` and its descendants, in registration order.
 *
 * Each entry has the handler, the owner record of the container that owns it, and its metadata.
 * `H` is the handler type that the caller expects. injeca does not check it.
 */
export function listeners<H = (...args: never[]) => unknown>(container: Container, eventKey: EventKey): readonly ListenerEntry<H>[] {
  const id = readEventId(eventKey)

  return Object.freeze(subtreeOf(nodeOf(container))
    .filter(node => node.state !== 'disposed')
    .flatMap(node => (node.listeners.get(id) ?? []).map(record => ({ record, owner: node.owner })))
    .sort((a, b) => a.record.seq - b.record.seq)
    .map(({ record, owner }): ListenerEntry<H> => Object.freeze({ handler: record.handler as H, owner, metadata: record.metadata })))
}
