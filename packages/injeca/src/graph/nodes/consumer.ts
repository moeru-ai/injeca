import type { ContainerNode, ServiceNode } from '../graph'

import { batch } from '../../helpers/signals'
import { publishService } from './container'
import { createService } from './service'

/**
 * Returns the service of a `perConsumer` registration for one consumer container. It creates the service on first use.
 *
 * The service lives in the consumer container, so it disposes with that container. Its build context has the owner of the container as `consumer`.
 * It returns `undefined` when the registration is withdrawn or the container disposal started.
 */
export function ensureConsumerService(registration: ServiceNode, container: ContainerNode): ServiceNode | undefined {
  const existing = registration.signals.consumers().get(container)
  if (existing)
    return existing
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
      exclusive: registration.exclusive,
      template: registration,
      consumer: container.owner,
    })
    container.services.add(service)
    publishService(service)
  })

  return service
}
