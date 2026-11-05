import type { Container, EventKey, ListenerMetadata } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { assertActive, nodeOf } from '../graph/nodes'

/** Reads the `id` of an event key once. Any object with a non-empty string `id` is an event key. */
export function readEventId(eventKey: unknown): string {
  let id: unknown
  try {
    id = typeof eventKey === 'object' && eventKey !== null ? (eventKey as EventKey).id : undefined
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the id of the event key.', { cause: error })
  }
  if (typeof id !== 'string' || id.length === 0)
    throw new InvalidArgumentError('An event key must be an object with a non-empty string id.')

  return id
}

function readListenerMetadata(metadata: unknown): ListenerMetadata {
  if (metadata === undefined)
    return Object.freeze({})
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
    throw new InvalidArgumentError('The metadata of a listener must be a record.')

  try {
    return Object.freeze({ ...metadata })
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the metadata of the listener.', { cause: error })
  }
}

/**
 * Stores a listener for `eventKey`. The container owns it: `dispose(container)` removes it.
 *
 * injeca does not call the listener. The consumer reads the listeners with `listeners()` and runs them by its own rules.
 * Returns a function that removes the listener.
 */
export function listen<H extends (...args: never[]) => unknown>(container: Container, eventKey: EventKey, handler: H, metadata?: ListenerMetadata): () => void {
  const node = nodeOf(container)
  assertActive(node, 'listen')
  const id = readEventId(eventKey)
  if (typeof handler !== 'function')
    throw new InvalidArgumentError(`The listener for '${id}' is not a function.`)

  const record = Object.freeze({ seq: node.runtime.nextSeq(), handler, metadata: readListenerMetadata(metadata) })
  const records = node.listeners.get(id) ?? []
  node.listeners.set(id, [...records, record])

  return () => {
    const current = node.listeners.get(id)
    if (!current?.includes(record))
      return

    const rest = current.filter(entry => entry !== record)
    if (rest.length > 0)
      node.listeners.set(id, rest)
    else
      node.listeners.delete(id)
  }
}
