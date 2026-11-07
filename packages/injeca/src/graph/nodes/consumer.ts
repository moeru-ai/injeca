import type { UnitPhase } from '../../types'
import type { ContainerNode, UnitNode } from '../graph'

import { batch } from '../../helpers/signals'
import { publishUnit } from './container'
import { createUnit, setPhase } from './unit'

/** The phases of a consumer unit that lead to a build outcome. */
const waitingPhases: ReadonlySet<UnitPhase> = new Set<UnitPhase>(['pending', 'building', 'starting', 'retrying'])

/**
 * Returns the unit of a per-container registration for one consumer container. It creates the unit on first use.
 *
 * The unit lives in the consumer container, so it disposes with that container. Its build context has the owner of the container as `consumer`.
 * It returns `undefined` when the registration is withdrawn or the container disposal started.
 *
 * `demander` is the dependent, the `resolve` call, or the subscription that needs the unit.
 * A failed unit builds again for a demander that did not get a build since the unit last ran. So a new demand retries a failed consumer unit.
 */
export function ensureConsumerUnit(registration: UnitNode, container: ContainerNode, demander: object): UnitNode | undefined {
  const existing = registration.signals.consumers().get(container)
  if (existing) {
    if (existing.signals.phase() === 'failed' && existing.signals.present() && !existing.demanders.has(demander)) {
      existing.demanders.add(demander)
      existing.failure = undefined
      setPhase(existing, 'pending', { reason: 'A new demand tries the failed consumer unit again.' })
      existing.container.runtime.reconciler.markDirty(existing)
    }
    else if (waitingPhases.has(existing.signals.phase())) {
      // The demander gets the outcome of the build in progress.
      existing.demanders.add(demander)
    }
    return existing
  }
  if (!registration.signals.present() || container.state !== 'active')
    return undefined

  let unit: UnitNode | undefined
  batch(() => {
    unit = createUnit({
      container,
      kind: 'unit',
      name: registration.name,
      edges: registration.edges,
      build: registration.build,
      metadata: registration.metadata,
      policy: registration.policy,
      exclusive: registration.exclusive,
      template: registration,
      consumer: container.owner,
    })
    unit.demanders.add(demander)
    container.units.add(unit)
    publishUnit(unit)
  })

  return unit
}

/**
 * Makes `subscription` demand the consumer unit of `registration` for `container`, so that it builds also before `start()`.
 * Returns the unit, or `undefined` when it cannot exist. `releaseConsumerDemand` ends the demand.
 */
export function demandConsumerUnit(registration: UnitNode, container: ContainerNode, subscription: object): UnitNode | undefined {
  const unit = ensureConsumerUnit(registration, container, subscription)
  if (unit && !unit.signals.subscribers().has(subscription))
    unit.signals.subscribers(new Set([...unit.signals.subscribers(), subscription]))

  return unit
}

/** Ends the demand of `subscription` on `unit`. */
export function releaseConsumerDemand(unit: UnitNode, subscription: object): void {
  const subscribers = unit.signals.subscribers()
  if (subscribers.has(subscription))
    unit.signals.subscribers(new Set([...subscribers].filter(other => other !== subscription)))
}
