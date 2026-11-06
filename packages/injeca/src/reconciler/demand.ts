import type { UnitNode } from '../graph/graph'

import { ensureConsumerUnit } from '../graph/nodes'
import { candidatesOf } from '../graph/resolvers/resolvers'

/**
 * An active unit makes the providers of its edges converge too, before `start()`. A fallback edge demands each candidate.
 * A per-container registration gets a unit for the scope of `unit`. The nearest registration of each key is demanded.
 *
 * A pending unit demands its providers before it builds. A running unit demands them too, so that an optional or a fallback edge to a key that registers later gets its consumer unit.
 */
export function demandProviders(unit: UnitNode): void {
  for (const edge of unit.edges) {
    for (const keyName of edge.candidates) {
      const candidates = candidatesOf(unit.scope, keyName, unit)
      const providers = candidates.map(registration => registration.instances === 'per-container' ? ensureConsumerUnit(registration, unit.scope, unit) : registration)
      const [nearest] = providers
      if (nearest && !nearest.signals.serving() && !nearest.signals.demanded())
        nearest.signals.demanded(true)
    }
  }
}
