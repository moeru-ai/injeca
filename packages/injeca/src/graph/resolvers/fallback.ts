import type { DependencyEdge, Resolution, ServiceNode } from '../graph'

import { resolveKey } from './plain'
import { isAvailable } from './resolvers'

/**
 * Resolves a `firstAvailable` edge. The first serving and available candidate wins.
 * If no serving candidate is available, the first serving candidate stays selected, so that a running dependent does not lose it.
 */
export function resolveFallback(consumer: ServiceNode, edge: DependencyEdge): Resolution {
  let firstNotRunning: Resolution | undefined
  let firstServing: Resolution | undefined
  for (const keyName of edge.candidates) {
    const resolution = resolveKey(consumer, keyName)
    if (resolution.kind === 'missing')
      continue
    if (resolution.kind === 'not-running') {
      firstNotRunning ??= resolution
      continue
    }

    if (isAvailable(resolution.provider))
      return resolution
    firstServing ??= resolution
  }

  return firstServing ?? firstNotRunning ?? { kind: 'missing' }
}
