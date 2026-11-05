import type { WritableSignal } from '../../helpers/signals'
import type { ContainerNode, ServiceNode } from '../graph'

import { signal } from 'alien-signals'

// Exported registrations. A registration with `export` lives in its container. It is also a candidate in the resolution area of the parent container.
// `nodes/container.ts` writes the exports at publish and release. `resolvers.ts` reads them in the candidate walk. `exclusive.ts` reads the area.

/** Returns the signal of the exported services of `keyName` that the child containers of `container` publish. It creates the signal on first read, so that resolution can track it. */
export function exportsOf(container: ContainerNode, keyName: string): WritableSignal<readonly ServiceNode[]> {
  let exports = container.signals.exports.get(keyName)
  if (!exports) {
    exports = signal<readonly ServiceNode[]>(Object.freeze([]))
    container.signals.exports.set(keyName, exports)
  }

  return exports
}

/**
 * The container whose resolution area a registration belongs to.
 * An exported registration belongs to the area of its parent container. A registration of a root container has no parent, so `export` has no effect there.
 */
export function areaOf(service: ServiceNode): ContainerNode {
  return (service.exported && service.container.parent) || service.container
}
