import type { WritableSignal } from '../../helpers/signals'
import type { ContainerNode, DependencyEdge, InstanceNode, Resolution, ServiceNode } from '../graph'

import { signal } from 'alien-signals'

/** Returns the slot signal of `keyName` in `container`. It creates the slot on first read, so that resolution can track it. */
export function slotOf(container: ContainerNode, keyName: string): WritableSignal<ServiceNode | undefined> {
  let slot = container.signals.slots.get(keyName)
  if (!slot) {
    slot = signal<ServiceNode | undefined>(undefined)
    container.signals.slots.set(keyName, slot)
  }

  return slot
}

/** Finds the current service for `keyName`, from `container` up to the root. A service does not resolve itself. */
export function findProvider(container: ContainerNode, keyName: string, consumer?: ServiceNode): ServiceNode | undefined {
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    const candidate = slotOf(current, keyName)()
    if (candidate && candidate !== consumer)
      return candidate
  }

  return undefined
}

/** `ready` and `degraded` count as available. A provider outside `running` has no status and is not available. */
export function isAvailable(provider: ServiceNode): boolean {
  const status = provider.signals.effective()
  return status !== undefined && status.status !== 'unavailable'
}

/** The current resolution of the edge. */
export function resolutionOf(service: ServiceNode, edge: DependencyEdge): Resolution {
  return service.signals.resolutions.get(edge.name)?.() ?? { kind: 'missing' }
}

/** The instance of the edge, when it resolves. */
export function resolvedInstance(service: ServiceNode, edge: DependencyEdge): InstanceNode | undefined {
  const resolution = resolutionOf(service, edge)
  return resolution.kind === 'resolved' ? resolution.instance : undefined
}

/** Tells whether each required edge resolves to an available provider. A pending service builds only then. */
export function requiredAvailable(service: ServiceNode): boolean {
  return service.edges.every((edge) => {
    if (edge.optional)
      return true

    const resolution = resolutionOf(service, edge)
    return resolution.kind === 'resolved' && isAvailable(resolution.provider)
  })
}

/** Tells whether a required edge no longer resolves: its provider was withdrawn, or it does not run. */
export function requiredWithdrawn(service: ServiceNode): boolean {
  return service.edges.some(edge => !edge.optional && resolvedInstance(service, edge) === undefined)
}

/** Tells whether the current resolution of a required edge differs from the bindings of `instance`. */
export function requiredChanged(service: ServiceNode, instance: InstanceNode): boolean {
  return service.edges.some(edge => !edge.optional && resolvedInstance(service, edge) !== instance.bindings.get(edge.name))
}

/** A build is discarded when its target is lost or a required dependency changed during the build. */
export function buildLost(service: ServiceNode, instance: InstanceNode): boolean {
  return !service.signals.present() || !service.signals.active() || requiredChanged(service, instance)
}

/** The identity of the dependency set: the revision and the instance id of each resolved required dependency. */
export function epochOf(service: ServiceNode, pick: (edge: DependencyEdge) => InstanceNode | undefined): string {
  const ids = service.edges
    .filter(edge => !edge.optional)
    .map(edge => `${edge.name}=${pick(edge)?.id ?? ''}`)

  return [String(service.revision), ...ids].join('|')
}

/**
 * Finds the failure that blocks a pending service: a required provider in `failed`, directly or through pending providers.
 */
export function blockingFailure(service: ServiceNode, visited = new Set<ServiceNode>()): { readonly error: unknown } | undefined {
  visited.add(service)
  for (const edge of service.edges) {
    if (edge.optional)
      continue

    const resolution = resolutionOf(service, edge)
    if (resolution.kind !== 'not-running' || visited.has(resolution.provider))
      continue

    const provider = resolution.provider
    const phase = provider.signals.phase()
    if (phase === 'failed')
      return provider.failure
    if (phase === 'pending') {
      const failure = blockingFailure(provider, visited)
      if (failure)
        return failure
    }
  }

  return undefined
}
