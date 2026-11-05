import type { ContainerNode, ServiceNode } from '../graph/graph'

import { subtreeOf } from '../graph/nodes'
import { candidatesOf, resolutionOf, serviceFor } from '../graph/resolvers/resolvers'

/** The plain result of an impact run, before it becomes graph entries. */
export interface ImpactSets {
  readonly stopped: ReadonlySet<ServiceNode>
  readonly rebuilt: ReadonlySet<ServiceNode>
  readonly notified: ReadonlySet<ServiceNode>
}

/** The proposed change as sets of services. */
export interface ProposedChange {
  /** The services that leave: a withdrawal or a disposal. */
  readonly removed: ReadonlySet<ServiceNode>
  /** The services that get a new instance: a replacement. */
  readonly renewed: ReadonlySet<ServiceNode>
}

const livePhases: ReadonlySet<string> = new Set(['building', 'starting', 'running'])

/** A service with an instance that a change can stop or rebuild. A new service that waits for its swap does not count. */
function isLive(service: ServiceNode): boolean {
  return service.kind !== 'resolver' && !service.swap && service.signals.instance() !== undefined && livePhases.has(service.signals.phase())
}

function rootOf(container: ContainerNode): ContainerNode {
  let root = container
  while (root.parent)
    root = root.parent

  return root
}

/** The services of a `perConsumer` registration, with the registration. */
function withConsumers(service: ServiceNode): ServiceNode[] {
  return [service, ...service.signals.consumers().values()]
}

/** Lists the services that leave when `container` and its descendants are disposed. */
export function disposedServices(container: ContainerNode): Set<ServiceNode> {
  return new Set(subtreeOf(container).flatMap(current => [...current.services]).flatMap(withConsumers))
}

/** Lists the services that leave when `service` is withdrawn. */
export function withdrawnServices(service: ServiceNode): Set<ServiceNode> {
  return new Set(withConsumers(service))
}

/**
 * Computes what a proposed change does, on a copy of the graph state. It reads the real graph and never writes it.
 *
 * - A dependent that loses a required dependency without an alternative provider stops. Its dependents follow.
 * - A dependent whose dependency gets another instance gets `dependency-change`. With a handler, it is notified. Without one, it rebuilds, and its dependents follow.
 * - An alternative provider is an ancestor registration that serves, or another `firstAvailable` candidate.
 */
export function computeImpact(scope: ContainerNode, change: ProposedChange): ImpactSets {
  const services = subtreeOf(rootOf(scope)).flatMap(container => [...container.services]).filter(isLive)
  const stopped = new Set<ServiceNode>([...change.removed].filter(isLive))
  const rebuilt = new Set<ServiceNode>()
  const notified = new Set<ServiceNode>()
  const gone = (service: ServiceNode): boolean => change.removed.has(service) || stopped.has(service)
  const renewed = (service: ServiceNode): boolean => change.renewed.has(service) || rebuilt.has(service)

  /** Tells whether another candidate of the edge serves after the change. */
  const alternative = (consumer: ServiceNode, keyNames: readonly string[]): boolean => keyNames.some(keyName =>
    candidatesOf(consumer.container, keyName, consumer).some((registration) => {
      const provider = serviceFor(registration, consumer.container)
      return provider !== undefined && !gone(provider) && !gone(registration) && provider.signals.serving()
    }))

  let changed = true
  while (changed) {
    changed = false
    for (const service of services) {
      if (stopped.has(service) || change.removed.has(service))
        continue

      let lost = false
      let identity = false
      for (const edge of service.edges) {
        const resolution = resolutionOf(service, edge)
        if (resolution.kind !== 'resolved')
          continue

        const provider = resolution.provider
        if (gone(provider)) {
          if (alternative(service, edge.candidates))
            identity = true
          else if (edge.optional)
            identity = true
          else
            lost = true
        }
        else if (renewed(provider)) {
          identity = true
        }
      }

      if (lost) {
        rebuilt.delete(service)
        notified.delete(service)
        stopped.add(service)
        changed = true
      }
      else if (identity && !rebuilt.has(service) && !notified.has(service)) {
        const instance = service.signals.instance()
        if (instance && instance.hooks['dependency-change'].length > 0) {
          notified.add(service)
        }
        else {
          rebuilt.add(service)
          changed = true
        }
      }
    }
  }

  return { stopped, rebuilt, notified }
}
