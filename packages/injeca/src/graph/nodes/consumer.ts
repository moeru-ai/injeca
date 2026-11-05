import type { ServicePhase } from '../../types'
import type { ContainerNode, ServiceNode } from '../graph'

import { batch } from '../../helpers/signals'
import { publishService } from './container'
import { createService, setPhase } from './service'

/** The phases of a consumer service that lead to a build outcome. */
const waitingPhases: ReadonlySet<ServicePhase> = new Set<ServicePhase>(['pending', 'building', 'starting', 'retrying'])

/**
 * Returns the service of a `perConsumer` registration for one consumer container. It creates the service on first use.
 *
 * The service lives in the consumer container, so it disposes with that container. Its build context has the owner of the container as `consumer`.
 * It returns `undefined` when the registration is withdrawn or the container disposal started.
 *
 * `demander` is the dependent, the `resolve` call, or the subscription that needs the service.
 * A failed service builds again for a demander that did not get a build since the service last ran. So a new demand retries a failed consumer service.
 */
export function ensureConsumerService(registration: ServiceNode, container: ContainerNode, demander: object): ServiceNode | undefined {
  const existing = registration.signals.consumers().get(container)
  if (existing) {
    if (existing.signals.phase() === 'failed' && existing.signals.present() && !existing.demanders.has(demander)) {
      existing.demanders.add(demander)
      existing.failure = undefined
      setPhase(existing, 'pending', { reason: 'A new demand tries the failed consumer service again.' })
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

  let service: ServiceNode | undefined
  batch(() => {
    service = createService({
      container,
      kind: 'service',
      name: registration.name,
      edges: registration.edges,
      build: registration.build,
      metadata: registration.metadata,
      policy: registration.policy,
      exclusive: registration.exclusive,
      template: registration,
      consumer: container.owner,
    })
    service.demanders.add(demander)
    container.services.add(service)
    publishService(service)
  })

  return service
}

/**
 * Makes `subscription` demand the consumer service of `registration` for `container`, so that it builds also before `start()`.
 * Returns the service, or `undefined` when it cannot exist. `releaseConsumerDemand` ends the demand.
 */
export function demandConsumerService(registration: ServiceNode, container: ContainerNode, subscription: object): ServiceNode | undefined {
  const service = ensureConsumerService(registration, container, subscription)
  if (service && !service.signals.subscribers().has(subscription))
    service.signals.subscribers(new Set([...service.signals.subscribers(), subscription]))

  return service
}

/** Ends the demand of `subscription` on `service`. */
export function releaseConsumerDemand(service: ServiceNode, subscription: object): void {
  const subscribers = service.signals.subscribers()
  if (subscribers.has(subscription))
    service.signals.subscribers(new Set([...subscribers].filter(other => other !== subscription)))
}
