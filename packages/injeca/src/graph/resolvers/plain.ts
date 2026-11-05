import type { DependencyEdge, Resolution, ServiceNode } from '../graph'

import { findProvider } from './resolvers'

/** Resolves one key name: the current provider, and its instance when the provider serves. */
export function resolveKey(consumer: ServiceNode, keyName: string): Resolution {
  const provider = findProvider(consumer.container, keyName, consumer)
  if (!provider)
    return { kind: 'missing' }

  const instance = provider.signals.instance()
  if (!provider.signals.serving() || !instance)
    return { kind: 'not-running', provider }

  return { kind: 'resolved', provider, instance }
}

/** Resolves a plain or an optional edge. It has one candidate key. */
export function resolvePlain(consumer: ServiceNode, edge: DependencyEdge): Resolution {
  const [keyName] = edge.candidates
  return keyName === undefined ? { kind: 'missing' } : resolveKey(consumer, keyName)
}
