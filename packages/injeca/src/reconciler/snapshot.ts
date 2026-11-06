import type { InstanceNode, UnitNode } from '../graph/graph'
import type { DependencyChange, DependencyState } from '../types'

import { resolutionOf } from '../graph/resolvers/resolvers'
import { batch } from '../helpers/signals'
import { syncHolds } from './holds'

/** One dependency of the current snapshot: its state for the handler, and the instance that a binding holds. */
export interface SnapshotEntry {
  readonly state: DependencyState
  readonly instance: InstanceNode
}

export type Snapshot = ReadonlyMap<string, SnapshotEntry | undefined>

/** The current snapshot of all dependencies. */
export function currentSnapshot(unit: UnitNode): Map<string, SnapshotEntry | undefined> {
  const snapshot = new Map<string, SnapshotEntry | undefined>()
  for (const edge of unit.edges) {
    const resolution = resolutionOf(unit, edge)
    snapshot.set(edge.name, resolution.kind === 'resolved'
      ? {
          state: Object.freeze({
            provider: resolution.provider.name,
            instanceId: resolution.instance.id,
            status: resolution.provider.signals.effective()?.status ?? 'unavailable',
          }),
          instance: resolution.instance,
        }
      : undefined)
  }

  return snapshot
}

/** The difference between the last handled snapshot and `snapshot`. An identity change wins over a status change. */
export function diffSnapshot(unit: UnitNode, handled: InstanceNode['handled'], snapshot: Snapshot): DependencyChange[] {
  const changes: DependencyChange[] = []
  for (const edge of unit.edges) {
    const from = handled.get(edge.name)
    const to = snapshot.get(edge.name)?.state
    if (from?.instanceId !== to?.instanceId || (from && to && from.status !== to.status))
      changes.push(Object.freeze({ key: edge.name, from, to }))
  }

  return changes
}

export function isIdentityChange(change: DependencyChange): boolean {
  return change.from?.instanceId !== change.to?.instanceId
}

export function describeChanges(changes: readonly DependencyChange[]): string {
  return changes
    .map(change => `${change.key}: ${change.from ? `${change.from.instanceId}/${change.from.status}` : '-'} -> ${change.to ? `${change.to.instanceId}/${change.to.status}` : '-'}`)
    .join(', ')
}

export function hookDependsOn(unit: UnitNode, snapshot: Snapshot): Readonly<Record<string, unknown>> {
  const dependsOn: Record<string, unknown> = {}
  for (const edge of unit.edges) {
    const entry = snapshot.get(edge.name)
    dependsOn[edge.name] = entry ? Object.freeze({ ...entry.state, value: entry.instance.value }) : undefined
  }

  return Object.freeze(dependsOn)
}

/** Marks `snapshot` as handled and moves the bindings to its instances. */
export function acceptSnapshot(unit: UnitNode, instance: InstanceNode, snapshot: Snapshot): void {
  instance.extraHolds.clear()
  instance.handled = new Map([...snapshot].map(([name, entry]) => [name, entry?.state]))
  instance.bindings.clear()
  for (const [name, entry] of snapshot) {
    if (entry)
      instance.bindings.set(name, entry.instance)
  }
  batch(() => syncHolds(unit, instance))
}
