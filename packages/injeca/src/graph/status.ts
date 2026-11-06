import type { StatusCause, UnitPhase, UnitStatus } from '../types'
import type { DependencyEdge, InstanceNode, Resolution, StatusValue, UnitNode } from './graph'

import { computed } from 'alien-signals'

import { withoutUndefined } from '../helpers/without-undefined'
import { emitRecord } from './observers'

const statusRank: Readonly<Record<UnitStatus, number>> = { ready: 0, degraded: 1, unavailable: 2 }

/** Tells whether `a` is worse than `b`. The order is `ready`, then `degraded`, then `unavailable`. */
export function worseThan(a: UnitStatus, b: UnitStatus): boolean {
  return statusRank[a] > statusRank[b]
}

function sameCause(a: StatusCause | undefined, b: StatusCause | undefined): boolean {
  if (a === b)
    return true
  if (!a || !b)
    return false

  return a.key === b.key && a.owner === b.owner && a.status === b.status && a.reason === b.reason && sameCause(a.cause, b.cause)
}

/** Tells whether two status values have the same status, reason, and cause. */
export function sameStatus(a: StatusValue | undefined, b: StatusValue | undefined): boolean {
  if (a === b)
    return true
  if (!a || !b)
    return false

  return a.status === b.status && a.reason === b.reason && sameCause(a.cause, b.cause)
}

export function statusFields(status: StatusValue): { reason?: string, cause?: StatusCause } {
  return withoutUndefined({ reason: status.reason, cause: status.cause })
}

/** The cause that a dependent reports when `provider` makes its effective status worse. */
export function causeOf(provider: UnitNode, status: StatusValue): StatusCause {
  return Object.freeze({
    key: provider.name,
    owner: provider.container.owner,
    status: status.status,
    ...withoutUndefined({ reason: status.reason, cause: status.cause }),
  })
}

export interface EffectiveStatusInput {
  readonly phase: () => UnitPhase
  readonly instance: () => InstanceNode | undefined
  readonly edges: readonly DependencyEdge[]
  readonly resolutions: ReadonlyMap<string, () => Resolution>
}

/**
 * Creates the effective status of a unit: the worst of the own status and the effective status of each required dependency.
 * An optional dependency does not count. It is `undefined` outside `running`.
 */
export function createEffectiveStatus(input: EffectiveStatusInput): () => StatusValue | undefined {
  const { phase, instance, edges, resolutions } = input

  return computed<StatusValue | undefined>((previous) => {
    const current = instance()
    if (phase() !== 'running' || !current)
      return undefined

    let result: StatusValue = current.signals.own()
    for (const edge of edges) {
      if (edge.optional)
        continue

      const resolution = resolutions.get(edge.name)?.()
      if (resolution?.kind !== 'resolved')
        continue

      const dependency = resolution.provider.signals.effective()
      if (dependency && worseThan(dependency.status, result.status))
        result = { status: dependency.status, cause: causeOf(resolution.provider, dependency) }
    }

    return previous && sameStatus(previous, result) ? previous : result
  })
}

/** Reports a change of the effective status. The status effect of each unit calls it. */
export function reportStatus(unit: UnitNode, next: StatusValue | undefined): void {
  const previous = unit.reportedStatus
  unit.reportedStatus = next
  if (!next || sameStatus(previous, next))
    return

  emitRecord(unit.container, {
    type: 'status',
    key: unit.name,
    owner: unit.container.owner,
    instanceId: unit.signals.instance()?.id,
    from: previous?.status,
    to: next.status,
    ...statusFields(next),
  })
}
