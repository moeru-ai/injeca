import type { InstanceNode, ServiceNode } from '../graph/graph'

import { batch } from '../helpers/signals'

function addHolder(provider: InstanceNode, holder: ServiceNode): void {
  const holders = provider.signals.holders()
  if (!holders.has(holder))
    provider.signals.holders(new Set([...holders, holder]))
}

function removeHolder(provider: InstanceNode, holder: ServiceNode): void {
  const holders = provider.signals.holders()
  if (holders.has(holder))
    provider.signals.holders(new Set([...holders].filter(service => service !== holder)))
}

/** Registers `service` as a holder of each bound instance and of each extra hold, and releases the rest. */
export function syncHolds(service: ServiceNode, instance: InstanceNode): void {
  const wanted = new Set([...instance.bindings.values(), ...instance.extraHolds])
  for (const provider of [...instance.held]) {
    if (!wanted.has(provider)) {
      removeHolder(provider, service)
      instance.held.delete(provider)
    }
  }
  for (const provider of wanted) {
    if (!instance.held.has(provider)) {
      addHolder(provider, service)
      instance.held.add(provider)
    }
  }
}

export function releaseExtraHolds(service: ServiceNode, instance: InstanceNode): void {
  instance.extraHolds.clear()
  batch(() => syncHolds(service, instance))
}
