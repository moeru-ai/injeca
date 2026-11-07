import type { WritableSignal } from '../../helpers/signals'
import type { ContainerNode, UnitNode } from '../graph'

import { signal } from 'alien-signals'

// Parent-visible registrations. A registration with `visibility: 'parent'` lives in its container. It is also a candidate in the resolution area of the parent container.
// `nodes/container.ts` writes the child units at publish and release. `resolvers.ts` reads them in the candidate walk. `exclusive.ts` reads the area.

/** Returns the signal of the parent-visible units of `keyName` that the child containers of `container` publish. It creates the signal on first read, so that resolution can track it. */
export function childUnitsOf(container: ContainerNode, keyName: string): WritableSignal<readonly UnitNode[]> {
  let units = container.signals.childUnits.get(keyName)
  if (!units) {
    units = signal<readonly UnitNode[]>(Object.freeze([]))
    container.signals.childUnits.set(keyName, units)
  }

  return units
}

/**
 * The container whose resolution area a registration belongs to.
 * A parent-visible registration belongs to the area of its parent container. A registration of a root container has no parent, so `visibility: 'parent'` has no effect there.
 */
export function areaOf(unit: UnitNode): ContainerNode {
  return (unit.visibility === 'parent' && unit.container.parent) || unit.container
}
