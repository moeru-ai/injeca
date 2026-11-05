import type { ResolutionCondition } from '../../types'
import type { DependencyEdge, Resolution, ServiceNode } from '../graph'

import { acceptsProvider } from './condition'
import { selectProvider } from './resolvers'

/**
 * Resolves one key name: the selected provider, and its instance when the provider serves.
 * A provider in conflict, or one that `condition` rejects, does not resolve.
 */
export function resolveKey(consumer: ServiceNode, keyName: string, condition?: ResolutionCondition): Resolution {
  const selection = selectProvider(consumer.container, keyName, consumer)
  if (!selection)
    return { kind: 'missing' }

  const { registration, provider } = selection
  const rivals = registration.signals.rivals()
  if (rivals.length > 0)
    return { kind: 'conflict', provider: registration, rivals }
  if (condition && !acceptsProvider(consumer, keyName, condition, registration))
    return { kind: 'rejected', provider: registration }
  if (!provider)
    return { kind: 'not-running', provider: registration }

  const instance = provider.signals.instance()
  if (!provider.signals.serving() || !instance)
    return { kind: 'not-running', provider }

  return { kind: 'resolved', provider, instance }
}

/** Resolves a plain or an optional edge. It has one candidate key. */
export function resolvePlain(consumer: ServiceNode, edge: DependencyEdge): Resolution {
  const [keyName] = edge.candidates
  return keyName === undefined ? { kind: 'missing' } : resolveKey(consumer, keyName, edge.condition)
}
