import type { WritableSignal } from '../../helpers/signals'
import type { ContainerNode, DependencyEdge, InstanceNode, Resolution, ResolutionConsumer, UnitNode } from '../graph'

import { signal } from 'alien-signals'

import { childUnitsOf } from './visibility'

/** Returns the slot signal of `keyName` in `container`. It creates the slot on first read, so that resolution can track it. */
export function slotOf(container: ContainerNode, keyName: string): WritableSignal<UnitNode | undefined> {
  let slot = container.signals.slots.get(keyName)
  if (!slot) {
    slot = signal<UnitNode | undefined>(undefined)
    container.signals.slots.set(keyName, slot)
  }

  return slot
}

/**
 * Lists the registrations of `keyName` that a consumer in `container` can see, nearest first.
 *
 * At each level, from `container` up through its ancestors, the candidates are the registration of that container, then the parent-visible units of its child containers in creation order.
 * The walk ends at a container that has the key as a local key. So a local key also hides the parent-visible units of the siblings.
 * A unit does not resolve itself. A consumer unit of a per-container registration does not resolve its registration.
 */
export function candidatesOf(container: ContainerNode, keyName: string, consumer?: ResolutionConsumer): UnitNode[] {
  const candidates: UnitNode[] = []
  const add = (candidate: UnitNode | undefined): void => {
    if (candidate && candidate !== consumer && candidate !== consumer?.template && !candidates.includes(candidate))
      candidates.push(candidate)
  }
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    add(slotOf(current, keyName)())
    for (const child of childUnitsOf(current, keyName)())
      add(child)
    if (current.localKeys.has(keyName))
      break
  }

  return candidates
}

/** The unit that serves `registration` for a consumer in `container`. A per-container registration has one for each consumer container, or none yet. */
export function unitFor(registration: UnitNode, container: ContainerNode): UnitNode | undefined {
  return registration.instances === 'per-container' ? registration.signals.consumers().get(container) : registration
}

/** A selected provider: the registration that a consumer sees, and the unit that serves it. */
export interface Selection {
  readonly registration: UnitNode
  /** The unit of a per-container registration for the consumer container. It is `undefined` until the reconciler creates it. */
  readonly provider: UnitNode | undefined
}

/**
 * Selects the provider of `keyName` for a consumer in `container`.
 *
 * A nearer registration shadows an ancestor only while it is `running`. Until then, the first serving registration wins.
 * If no registration serves, the nearest one is selected. So shadowing never leaves a gap.
 */
export function selectProvider(container: ContainerNode, keyName: string, consumer?: ResolutionConsumer): Selection | undefined {
  const candidates = candidatesOf(container, keyName, consumer)
  for (const registration of candidates) {
    const provider = unitFor(registration, container)
    if (provider?.signals.serving())
      return { registration, provider }
  }

  const [nearest] = candidates
  return nearest ? { registration: nearest, provider: unitFor(nearest, container) } : undefined
}

/** Finds the unit for `keyName` that a consumer in `container` sees. A per-container registration without a unit for the container gives the registration. */
export function findProvider(container: ContainerNode, keyName: string, consumer?: ResolutionConsumer): UnitNode | undefined {
  const selection = selectProvider(container, keyName, consumer)
  return selection && (selection.provider ?? selection.registration)
}

/** `ready` and `degraded` count as available. A provider outside `running` has no status and is not available. */
export function isAvailable(provider: UnitNode): boolean {
  const status = provider.signals.effective()
  return status !== undefined && status.status !== 'unavailable'
}

/** The current resolution of the edge. */
export function resolutionOf(unit: UnitNode, edge: DependencyEdge): Resolution {
  return unit.signals.resolutions.get(edge.name)?.() ?? { kind: 'missing' }
}

/** The instance of the edge, when it resolves. */
export function resolvedInstance(unit: UnitNode, edge: DependencyEdge): InstanceNode | undefined {
  const resolution = resolutionOf(unit, edge)
  return resolution.kind === 'resolved' ? resolution.instance : undefined
}

/** Tells whether each required edge resolves to an available provider. A pending unit builds only then. */
export function requiredAvailable(unit: UnitNode): boolean {
  return unit.edges.every((edge) => {
    if (edge.optional)
      return true

    const resolution = resolutionOf(unit, edge)
    return resolution.kind === 'resolved' && isAvailable(resolution.provider)
  })
}

/** Tells whether a required edge no longer resolves: its provider was withdrawn, or it does not run. */
export function requiredWithdrawn(unit: UnitNode): boolean {
  return unit.edges.some(edge => !edge.optional && resolvedInstance(unit, edge) === undefined)
}

/** Tells whether the current resolution of a required edge differs from the bindings of `instance`. */
export function requiredChanged(unit: UnitNode, instance: InstanceNode): boolean {
  return unit.edges.some(edge => !edge.optional && resolvedInstance(unit, edge) !== instance.bindings.get(edge.name))
}

/** A build is discarded when its target is lost, a required dependency changed during the build, or the key went into conflict. */
export function buildLost(unit: UnitNode, instance: InstanceNode): boolean {
  return !unit.signals.present() || !unit.signals.active() || unit.signals.rivals().length > 0 || requiredChanged(unit, instance)
}

/** The identity of the dependency set: the revision and the instance id of each resolved required dependency. */
export function epochOf(unit: UnitNode, pick: (edge: DependencyEdge) => InstanceNode | undefined): string {
  const ids = unit.edges
    .filter(edge => !edge.optional)
    .map(edge => `${edge.name}=${pick(edge)?.id ?? ''}`)

  return [String(unit.revision), ...ids].join('|')
}

/**
 * Finds the failure that blocks a pending unit: a required provider in `failed`, directly or through pending providers.
 */
export function blockingFailure(unit: UnitNode, visited = new Set<UnitNode>()): { readonly error: unknown } | undefined {
  visited.add(unit)
  for (const edge of unit.edges) {
    if (edge.optional)
      continue

    const resolution = resolutionOf(unit, edge)
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
