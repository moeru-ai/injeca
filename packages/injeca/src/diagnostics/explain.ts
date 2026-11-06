import type { ServiceNode } from '../graph/graph'
import type { OwnerRecord, ServiceBlocker, ServiceExplanation, StatusCause } from '../types'

import { resolveKey } from '../graph/resolvers/plain'
import { resolutionOf } from '../graph/resolvers/resolvers'
import { causeOf } from '../graph/status'
import { withoutUndefined } from '../helpers/without-undefined'

/** The owners of conflicting declarations, in container order. The order of the registrations has no effect. */
export function ownersOf(declarations: readonly ServiceNode[]): readonly OwnerRecord[] {
  return Object.freeze([...declarations].sort((a, b) => a.container.seq - b.container.seq).map(declaration => declaration.container.owner))
}

/** Explains one service from its current resolution data. It is a pure read. */
export function explainService(service: ServiceNode): ServiceExplanation {
  const blockers: ServiceBlocker[] = []
  const phase = service.signals.phase()

  if (phase === 'failed')
    blockers.push({ kind: 'failed', error: service.failure?.error })
  if (phase === 'retrying') {
    const previous = service.signals.instance()?.hookStates.get('start')?.previous
    blockers.push({ kind: 'retrying', attempt: previous?.attempt ?? 1, ...withoutUndefined({ reason: previous?.reason }) })
  }
  const rivals = service.signals.rivals()
  if (rivals.length > 0) {
    const registration = service.template ?? service
    blockers.push({ kind: 'conflict', key: service.name, owners: ownersOf([registration, ...rivals]) })
  }
  if (!service.signals.active() && !service.perConsumer)
    blockers.push({ kind: 'not-started' })

  for (const edge of service.edges) {
    if (edge.optional)
      continue

    const resolution = resolutionOf(service, edge)
    // A fallback edge that does not resolve names each candidate that a condition rejected.
    if (edge.fallback && resolution.kind !== 'resolved') {
      for (const keyName of edge.candidates) {
        const candidate = resolveKey(service, keyName, edge)
        if (candidate.kind === 'rejected')
          blockers.push({ kind: 'rejected-provider', dependency: edge.name, key: candidate.provider.name, owner: candidate.provider.container.owner, metadata: candidate.provider.metadata })
      }
      if (resolution.kind === 'rejected')
        continue
    }
    switch (resolution.kind) {
      case 'missing':
        blockers.push({ kind: 'missing-provider', dependency: edge.name, key: edge.keyName })
        continue
      case 'rejected':
        blockers.push({ kind: 'rejected-provider', dependency: edge.name, key: resolution.provider.name, owner: resolution.provider.container.owner, metadata: resolution.provider.metadata })
        continue
      case 'conflict':
        blockers.push({ kind: 'conflicting-dependency', dependency: edge.name, key: resolution.provider.name, owners: ownersOf([resolution.provider, ...resolution.rivals]) })
        continue
      case 'resolved': {
        const status = resolution.provider.signals.effective()
        // A running service keeps an unavailable dependency. Its own status reports it. Only a waiting service lists it as a blocker.
        if (phase !== 'running' && status?.status === 'unavailable')
          blockers.push({ kind: 'unavailable-dependency', dependency: edge.name, key: resolution.provider.name, cause: causeOf(resolution.provider, status) })
        continue
      }
      case 'not-running': {
        const providerPhase = resolution.provider.signals.phase()
        blockers.push(providerPhase === 'failed'
          ? { kind: 'failed-dependency', dependency: edge.name, key: edge.keyName, error: resolution.provider.failure?.error }
          : { kind: 'pending-dependency', dependency: edge.name, key: edge.keyName, phase: providerPhase })
      }
    }
  }

  const status = service.signals.effective()
  const successor = service.successor
  return Object.freeze({
    name: service.name,
    kind: service.kind === 'invocation' ? 'invocation' : 'service',
    owner: service.container.owner,
    phase,
    ...withoutUndefined({ status: status?.status, reason: status?.reason, cause: status?.cause }),
    blockers: Object.freeze(blockers),
    ...withoutUndefined({ replacement: successor?.signals.present() ? explainService(successor) : undefined }),
  })
}

/** Formats a cause chain, for example `'airi.llm' is unavailable (reason), because 'gateway/store' is unavailable`. */
export function describeCause(cause: StatusCause): string {
  const parts: string[] = []
  for (let current: StatusCause | undefined = cause; current; current = current.cause)
    parts.push(`'${current.key}' is ${current.status}${current.reason === undefined ? '' : ` (${current.reason})`}`)

  return parts.join(', because ')
}

function describeOwners(owners: readonly OwnerRecord[]): string {
  return owners.map(owner => JSON.stringify(owner)).join(', ')
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
    case 'rejected-provider':
      return `a resolution condition rejected the provider of '${blocker.key}' from ${JSON.stringify(blocker.owner)} (${blocker.dependency})`
    case 'conflicting-dependency':
      return `the exclusive key '${blocker.key}' (${blocker.dependency}) has more than one declaration: ${describeOwners(blocker.owners)}`
    case 'conflict':
      return `the exclusive key '${blocker.key}' has more than one declaration: ${describeOwners(blocker.owners)}`
    case 'failed':
      return 'the service failed'
    case 'retrying':
      return `its start hook requeued after attempt ${blocker.attempt}${blocker.reason === undefined ? '' : ` (${blocker.reason})`}`
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
      const { replacement } = explanation
      if (replacement) {
        const blockers = replacement.blockers.map(describeBlocker)
        reasons.push(`its replacement is ${replacement.phase ?? 'missing'}${blockers.length > 0 ? ` (${blockers.join(', ')})` : ''}`)
      }
      return `- ${explanation.name} is ${explanation.phase}${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}`
    })
    .join('\n')
}
