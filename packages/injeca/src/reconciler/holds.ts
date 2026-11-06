import type { InstanceNode, UnitNode } from '../graph/graph'

import { batch } from '../helpers/signals'

function addHolder(provider: InstanceNode, holder: UnitNode): void {
  const holders = provider.signals.holders()
  if (!holders.has(holder))
    provider.signals.holders(new Set([...holders, holder]))
}

function removeHolder(provider: InstanceNode, holder: UnitNode): void {
  const holders = provider.signals.holders()
  if (holders.has(holder))
    provider.signals.holders(new Set([...holders].filter(unit => unit !== holder)))
}

/** Registers `unit` as a holder of each bound instance and of each extra hold, and releases the rest. */
export function syncHolds(unit: UnitNode, instance: InstanceNode): void {
  const wanted = new Set([...instance.bindings.values(), ...instance.extraHolds])
  for (const provider of [...instance.held]) {
    if (!wanted.has(provider)) {
      removeHolder(provider, unit)
      instance.held.delete(provider)
    }
  }
  for (const provider of wanted) {
    if (!instance.held.has(provider)) {
      addHolder(provider, unit)
      instance.held.add(provider)
    }
  }
}

export function releaseExtraHolds(unit: UnitNode, instance: InstanceNode): void {
  instance.extraHolds.clear()
  batch(() => syncHolds(unit, instance))
}
