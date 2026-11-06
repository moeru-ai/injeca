import type { DependencyEdge, Resolution, ResolutionConsumer } from '../graph'

import { acceptsCandidate } from './condition'
import { selectProvider } from './resolvers'

/**
 * Resolves one key name: the selected provider, and its instance when the provider serves.
 * A provider in conflict, or one that a condition of `edge` for `keyName` rejects, does not resolve.
 */
export function resolveKey(consumer: ResolutionConsumer, keyName: string, edge?: DependencyEdge): Resolution {
  const selection = selectProvider(consumer.scope, keyName, consumer)
  if (!selection)
    return { kind: 'missing' }

  const { registration, provider } = selection
  const rivals = registration.signals.rivals()
  if (rivals.length > 0)
    return { kind: 'conflict', provider: registration, rivals }
  if (!acceptsCandidate(consumer, edge, keyName, registration))
    return { kind: 'rejected', provider: registration }
  if (!provider)
    return { kind: 'not-running', provider: registration }

  const instance = provider.signals.instance()
  if (!provider.signals.serving() || !instance)
    return { kind: 'not-running', provider }

  return { kind: 'resolved', provider, instance }
}

/** Resolves a plain or an optional edge. It has one candidate key. */
export function resolvePlain(consumer: ResolutionConsumer, edge: DependencyEdge): Resolution {
  const [keyName] = edge.candidates
  return keyName === undefined ? { kind: 'missing' } : resolveKey(consumer, keyName, edge)
}
