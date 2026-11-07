import type { ContainerNode, UnitNode } from '../graph/graph'

import { subtreeOf } from '../graph/nodes'
import { candidatesOf, resolutionOf, unitFor } from '../graph/resolvers/resolvers'

/** The plain result of an impact run, before it becomes graph entries. */
export interface ImpactSets {
  readonly stopped: ReadonlySet<UnitNode>
  readonly rebuilt: ReadonlySet<UnitNode>
  readonly notified: ReadonlySet<UnitNode>
}

/** The proposed change as sets of units. */
export interface ProposedChange {
  /** The units that leave: a withdrawal or a disposal. */
  readonly removed: ReadonlySet<UnitNode>
  /** The units that get a new instance: a replacement. */
  readonly renewed: ReadonlySet<UnitNode>
}

const livePhases: ReadonlySet<string> = new Set(['building', 'starting', 'retrying', 'running'])

/** A unit with an instance that a change can stop or rebuild. A new unit that waits for its swap does not count. */
function isLive(unit: UnitNode): boolean {
  return unit.kind !== 'resolver' && !unit.swap && unit.signals.instance() !== undefined && livePhases.has(unit.signals.phase())
}

function rootOf(container: ContainerNode): ContainerNode {
  let root = container
  while (root.parent)
    root = root.parent

  return root
}

/** The units of a per-container registration, with the registration. */
function withConsumers(unit: UnitNode): UnitNode[] {
  return [unit, ...unit.signals.consumers().values()]
}

/** Lists the units that leave when `container` and its descendants are disposed. */
export function disposedUnits(container: ContainerNode): Set<UnitNode> {
  return new Set(subtreeOf(container).flatMap(current => [...current.units]).flatMap(withConsumers))
}

/** Lists the units that leave when `unit` is withdrawn. */
export function withdrawnUnits(unit: UnitNode): Set<UnitNode> {
  return new Set(withConsumers(unit))
}

/**
 * Computes what a proposed change does, on a copy of the graph state. It reads the real graph and never writes it.
 *
 * - A dependent that loses a required dependency without an alternative provider stops. Its dependents follow.
 * - A dependent whose dependency gets another instance gets `dependency-change`. With a handler, it is notified. Without one, it rebuilds, and its dependents follow.
 * - An alternative provider is an ancestor registration that serves, or another `firstAvailable` candidate.
 */
export function computeImpact(scope: ContainerNode, change: ProposedChange): ImpactSets {
  const units = subtreeOf(rootOf(scope)).flatMap(container => [...container.units]).filter(isLive)
  const stopped = new Set<UnitNode>([...change.removed].filter(isLive))
  const rebuilt = new Set<UnitNode>()
  const notified = new Set<UnitNode>()
  const gone = (unit: UnitNode): boolean => change.removed.has(unit) || stopped.has(unit)
  const renewed = (unit: UnitNode): boolean => change.renewed.has(unit) || rebuilt.has(unit)

  /** Tells whether another candidate of the edge serves after the change. */
  const alternative = (consumer: UnitNode, keyNames: readonly string[]): boolean => keyNames.some(keyName =>
    candidatesOf(consumer.scope, keyName, consumer).some((registration) => {
      const provider = unitFor(registration, consumer.scope)
      return provider !== undefined && !gone(provider) && !gone(registration) && provider.signals.serving()
    }))

  let changed = true
  while (changed) {
    changed = false
    for (const unit of units) {
      if (stopped.has(unit) || change.removed.has(unit))
        continue

      let lost = false
      let identity = false
      for (const edge of unit.edges) {
        const resolution = resolutionOf(unit, edge)
        if (resolution.kind !== 'resolved')
          continue

        const provider = resolution.provider
        if (gone(provider)) {
          if (alternative(unit, edge.candidates))
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
        rebuilt.delete(unit)
        notified.delete(unit)
        stopped.add(unit)
        changed = true
      }
      else if (identity && !rebuilt.has(unit) && !notified.has(unit)) {
        const instance = unit.signals.instance()
        if (instance && instance.hooks['dependency-change'].length > 0) {
          notified.add(unit)
        }
        else {
          rebuilt.add(unit)
          changed = true
        }
      }
    }
  }

  return { stopped, rebuilt, notified }
}
