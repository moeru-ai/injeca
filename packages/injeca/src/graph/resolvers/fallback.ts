import type { DependencyEdge, Resolution, ResolutionConsumer } from '../graph'

import { resolveKey } from './plain'
import { isAvailable } from './resolvers'

/**
 * Resolves a `firstAvailable` edge. The first serving and available candidate wins.
 * If no serving candidate is available, the first serving candidate stays selected, so that a running dependent does not lose it.
 * Without a serving candidate, the edge reports the first candidate that exists.
 */
export function resolveFallback(consumer: ResolutionConsumer, edge: DependencyEdge): Resolution {
  let firstUnresolved: Resolution | undefined
  let firstServing: Resolution | undefined
  for (const keyName of edge.candidates) {
    const resolution = resolveKey(consumer, keyName, edge.condition)
    if (resolution.kind === 'missing')
      continue
    if (resolution.kind !== 'resolved') {
      firstUnresolved ??= resolution
      continue
    }

    if (isAvailable(resolution.provider))
      return resolution
    firstServing ??= resolution
  }

  return firstServing ?? firstUnresolved ?? { kind: 'missing' }
}
