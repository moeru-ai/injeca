import type { Resolution } from '../graph/graph'
import type { Container, PeekDependency, PeekResult, PeekValue } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { ownersOf } from '../diagnostics/explain'
import { nodeOf, readEdges } from '../graph/nodes'
import { resolveFallback } from '../graph/resolvers/fallback'
import { resolvePlain } from '../graph/resolvers/plain'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'

function resultOf(resolution: Resolution, fallbackKey: string): PeekResult<unknown> {
  switch (resolution.kind) {
    case 'missing':
      return Object.freeze({ kind: 'missing', key: fallbackKey })
    case 'conflict':
      return Object.freeze({ kind: 'conflict', key: resolution.provider.name, owners: ownersOf([resolution.provider, ...resolution.rivals]) })
    case 'rejected':
      return Object.freeze({ kind: 'rejected', key: resolution.provider.name, owner: resolution.provider.container.owner, metadata: resolution.provider.metadata })
    case 'not-running': {
      const { provider } = resolution
      const phase = provider.signals.phase()
      // A per-container registration without a unit for the container is `pending`. `peek` does not create one.
      const owner = (provider.template ?? provider).container.owner
      return Object.freeze({ kind: 'not-running', key: provider.name, owner, phase, ...(phase === 'failed' ? { error: provider.failure?.error } : {}) })
    }
    case 'resolved': {
      const { provider, instance } = resolution
      const owner = (provider.template ?? provider).container.owner
      const status = provider.signals.effective()
      if (!status || status.status === 'unavailable')
        return Object.freeze({ kind: 'unavailable', key: provider.name, owner, instanceId: instance.id, ...withoutUndefined({ reason: status?.reason, cause: status?.cause }) })

      return Object.freeze({ kind: 'resolved', key: provider.name, owner, value: instance.value, status: status.status, instanceId: instance.id })
    }
  }
}

/**
 * Reads the value of a dependency now, without a wait. It is a pure read: it does not demand, build, or start a unit.
 *
 * The dependency resolves as for a consumer in `container`: a key, `where(key, condition)`, or `firstAvailable(...)`. An `optional` marker has no effect.
 * The result is the value with its status, or the reason why no value is available now. A per-container key has a value only after something demanded its unit for `container`.
 */
export function peek<D extends PeekDependency>(container: Container, dependency: D): PeekResult<PeekValue<D>> {
  const node = nodeOf(container)
  const [edge] = readEdges('peek', { dependency })
  if (!edge)
    throw new InvalidArgumentError('peek() needs a dependency.')

  return untracked(() => {
    const consumer = { container: node, scope: node, name: 'peek', template: undefined }
    const resolution = edge.fallback ? resolveFallback(consumer, edge) : resolvePlain(consumer, edge)
    return resultOf(resolution, edge.candidates[0] ?? edge.keyName) as PeekResult<PeekValue<D>>
  })
}
