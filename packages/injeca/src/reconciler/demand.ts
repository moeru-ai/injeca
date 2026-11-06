import type { ServiceNode } from '../graph/graph'

import { ensureConsumerService } from '../graph/nodes'
import { candidatesOf } from '../graph/resolvers/resolvers'

/**
 * An active service makes the providers of its edges converge too, before `start()`. A fallback edge demands each candidate.
 * A `perConsumer` registration gets a service for the scope of `service`. The nearest registration of each key is demanded.
 *
 * A pending service demands its providers before it builds. A running service demands them too, so that an optional or a fallback edge to a key that registers later gets its consumer service.
 */
export function demandProviders(service: ServiceNode): void {
  for (const edge of service.edges) {
    for (const keyName of edge.candidates) {
      const candidates = candidatesOf(service.scope, keyName, service)
      const providers = candidates.map(registration => registration.perConsumer ? ensureConsumerService(registration, service.scope, service) : registration)
      const [nearest] = providers
      if (nearest && !nearest.signals.serving() && !nearest.signals.demanded())
        nearest.signals.demanded(true)
    }
  }
}
