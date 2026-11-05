import type { ServiceNode } from '../graph/graph'
import type { Container, DependencyMap, ProvidedKey, ServiceBlocker, ServiceExplanation, StatusCause } from '../types'

import { nodeOf } from '../graph/nodes'
import { resolutionOf, slotOf } from '../graph/resolvers/resolvers'
import { causeOf } from '../graph/status'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'
import { normalizeName } from '../primitives/keys'

/** Explains one service from its current resolution data. It is a pure read. */
export function explainService(service: ServiceNode): ServiceExplanation {
  const blockers: ServiceBlocker[] = []
  const phase = service.signals.phase()

  if (phase === 'failed')
    blockers.push({ kind: 'failed', error: service.failure?.error })
  if (!service.signals.active())
    blockers.push({ kind: 'not-started' })

  for (const edge of service.edges) {
    if (edge.optional)
      continue

    const resolution = resolutionOf(service, edge)
    if (resolution.kind === 'missing') {
      blockers.push({ kind: 'missing-provider', dependency: edge.name, key: edge.keyName })
      continue
    }
    if (resolution.kind === 'resolved') {
      const status = resolution.provider.signals.effective()
      // A running service keeps an unavailable dependency. Its own status reports it. Only a waiting service lists it as a blocker.
      if (phase !== 'running' && status?.status === 'unavailable')
        blockers.push({ kind: 'unavailable-dependency', dependency: edge.name, key: resolution.provider.name, cause: causeOf(resolution.provider, status) })
      continue
    }

    const providerPhase = resolution.provider.signals.phase()
    blockers.push(providerPhase === 'failed'
      ? { kind: 'failed-dependency', dependency: edge.name, key: edge.keyName, error: resolution.provider.failure?.error }
      : { kind: 'pending-dependency', dependency: edge.name, key: edge.keyName, phase: providerPhase })
  }

  const status = service.signals.effective()
  return Object.freeze({
    name: service.name,
    kind: service.kind === 'invocation' ? 'invocation' : 'service',
    owner: service.container.owner,
    phase,
    ...withoutUndefined({ status: status?.status, reason: status?.reason, cause: status?.cause }),
    blockers: Object.freeze(blockers),
  })
}

/**
 * Explains the current service of `key` in `container`. Tests use it. Step 3 replaces it with `graph(container).explain()`.
 *
 * @internal
 */
export function explainKey(container: Container, key: string | ProvidedKey<string, unknown, DependencyMap | undefined>): ServiceExplanation | undefined {
  return untracked(() => {
    const service = slotOf(nodeOf(container), normalizeName(key))()
    return service ? explainService(service) : undefined
  })
}

/** Formats a cause chain, for example `'airi.llm' is unavailable (reason), because 'gateway/store' is unavailable`. */
export function describeCause(cause: StatusCause): string {
  const parts: string[] = []
  for (let current: StatusCause | undefined = cause; current; current = current.cause)
    parts.push(`'${current.key}' is ${current.status}${current.reason === undefined ? '' : ` (${current.reason})`}`)

  return parts.join(', because ')
}

function describeBlocker(blocker: ServiceBlocker): string {
  switch (blocker.kind) {
    case 'missing-provider':
      return `no provider for '${blocker.key}' (${blocker.dependency})`
    case 'failed-dependency':
      return `'${blocker.key}' (${blocker.dependency}) failed`
    case 'pending-dependency':
      return `'${blocker.key}' (${blocker.dependency}) is ${blocker.phase}`
    case 'unavailable-dependency':
      return `${describeCause(blocker.cause)} (${blocker.dependency})`
    case 'failed':
      return 'the service failed'
    case 'not-started':
      return 'its container is not started'
  }
}

/** Formats explanations as one line for each service. */
export function describeExplanations(explanations: readonly ServiceExplanation[]): string {
  return explanations
    .map((explanation) => {
      const reasons = explanation.blockers.map(describeBlocker)
      if (explanation.cause)
        reasons.push(`it is ${explanation.status ?? 'unavailable'}, because ${describeCause(explanation.cause)}`)
      return `- ${explanation.name} is ${explanation.phase}${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}`
    })
    .join('\n')
}
