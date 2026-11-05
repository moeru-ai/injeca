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

/**
 * Lists the registrations of `keyName` that a consumer in `container` can see, nearest first.
 * The walk ends at a container that isolates the key. A service does not resolve itself.
 */
export function candidatesOf(container: ContainerNode, keyName: string, consumer?: ServiceNode): ServiceNode[] {
  const candidates: ServiceNode[] = []
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    const candidate = slotOf(current, keyName)()
    if (candidate && candidate !== consumer)
      candidates.push(candidate)
    if (current.isolated.has(keyName))
      break
  }

  return candidates
}

/** The service that serves `registration` for a consumer in `container`. A `perConsumer` registration has one for each consumer container, or none yet. */
export function serviceFor(registration: ServiceNode, container: ContainerNode): ServiceNode | undefined {
  return registration.perConsumer ? registration.signals.consumers().get(container) : registration
}

/** A selected provider: the registration that a consumer sees, and the service that serves it. */
export interface Selection {
  readonly registration: ServiceNode
  /** The service of a `perConsumer` registration for the consumer container. It is `undefined` until the reconciler creates it. */
  readonly provider: ServiceNode | undefined
}

/**
 * Selects the provider of `keyName` for a consumer in `container`.
 *
 * A nearer registration shadows an ancestor only while it is `running`. Until then, the first serving registration wins.
 * If no registration serves, the nearest one is selected. So shadowing never leaves a gap.
 */
export function selectProvider(container: ContainerNode, keyName: string, consumer?: ServiceNode): Selection | undefined {
  const candidates = candidatesOf(container, keyName, consumer)
  for (const registration of candidates) {
    const provider = serviceFor(registration, container)
    if (provider?.signals.serving())
      return { registration, provider }
  }

  const [nearest] = candidates
  return nearest ? { registration: nearest, provider: serviceFor(nearest, container) } : undefined
}

/** Finds the service for `keyName` that a consumer in `container` sees. A `perConsumer` registration without a service for the container gives the registration. */
export function findProvider(container: ContainerNode, keyName: string, consumer?: ServiceNode): ServiceNode | undefined {
  const selection = selectProvider(container, keyName, consumer)
  return selection && (selection.provider ?? selection.registration)
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

/** A build is discarded when its target is lost, a required dependency changed during the build, or the key went into conflict. */
export function buildLost(service: ServiceNode, instance: InstanceNode): boolean {
  return !service.signals.present() || !service.signals.active() || service.signals.rivals().length > 0 || requiredChanged(service, instance)
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
