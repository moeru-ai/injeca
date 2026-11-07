import type { Container } from '../../types'
import type { ContainerNode, UnitNode } from '../graph'

import { BuildAfterDisposeError, InvalidArgumentError } from '../../diagnostics/errors'
import { errorFrom } from '../../helpers/error-from'
import { batch, untracked } from '../../helpers/signals'
import { addDeclaration } from '../resolvers/exclusive'
import { slotOf } from '../resolvers/resolvers'
import { childUnitsOf } from '../resolvers/visibility'

const nodes = new WeakMap<Container, ContainerNode>()

/** Connects the public container object to its node. `createContainer` calls it once. */
export function registerNode(container: Container, node: ContainerNode): void {
  nodes.set(container, node)
}

/** Returns the internal node of a container from `createContainer`. */
export function nodeOf(container: Container): ContainerNode {
  const node = typeof container === 'object' && container !== null ? nodes.get(container) : undefined
  if (!node)
    throw new InvalidArgumentError('The value is not a container from createContainer.')

  return node
}

export function assertActive(container: ContainerNode, action: string): void {
  if (container.state !== 'active')
    throw new BuildAfterDisposeError(`Cannot ${action} after the container disposal started.`)
}

/** Lists `container` and its descendants that were started, through started containers only. `start()` and `stop()` apply to them. */
export function affectedContainers(container: ContainerNode): ContainerNode[] {
  const result = [container]
  for (const child of container.children) {
    if (child.enrolled)
      result.push(...affectedContainers(child))
  }

  return result
}

/** Lists `container` and all its descendants. */
export function subtreeOf(container: ContainerNode): ContainerNode[] {
  return [container, ...[...container.children].flatMap(subtreeOf)]
}

/**
 * Adds a parent-visible unit to the child units of its parent container, in container creation order.
 * It takes the place of an earlier unit of the same container, for example at the swap of a replacement.
 */
function addToParent(unit: UnitNode): void {
  const parent = unit.container.parent
  if (unit.visibility === 'local' || !parent)
    return

  const units = childUnitsOf(parent, unit.name)
  const current = units()
  if (current.includes(unit))
    return

  units(Object.freeze([...current.filter(other => other.container !== unit.container), unit].sort((a, b) => a.container.seq - b.container.seq)))
}

function removeFromParent(unit: UnitNode): void {
  const parent = unit.container.parent
  if (unit.visibility === 'local' || !parent)
    return

  const units = childUnitsOf(parent, unit.name)
  if (units().includes(unit))
    units(Object.freeze(units().filter(other => other !== unit)))
}

/**
 * Makes `unit` visible to consumers: the slot of its key, or the consumer map of its per-container registration.
 * A parent-visible unit is also visible in the resolution area of the parent container.
 * An exclusive conflict counts each published unit with a key.
 */
export function publishUnit(unit: UnitNode): void {
  const { template } = unit
  if (template) {
    const consumers = template.signals.consumers()
    if (consumers.get(unit.container) !== unit)
      template.signals.consumers(new Map([...consumers, [unit.container, unit]]))
    return
  }

  slotOf(unit.container, unit.name)(unit)
  addToParent(unit)
  addDeclaration(unit)
}

/**
 * Clears the slot and marks the unit absent. The reconciler stops it after its holders release it.
 * A per-container registration also releases the unit of each consumer container.
 */
export function releaseUnit(unit: UnitNode): void {
  unit.signals.present(false)
  if (unit.kind !== 'unit' || unit.template)
    return

  for (const consumer of unit.signals.consumers().values())
    consumer.signals.present(false)

  const slot = slotOf(unit.container, unit.name)
  if (slot() === unit)
    slot(undefined)
  removeFromParent(unit)
}

/** Waits until `unit` is `withdrawn`. Rejects with its teardown errors. */
export async function awaitWithdrawal(unit: UnitNode): Promise<void> {
  const errors = await unit.withdrawal.promise
  if (errors.length > 0)
    throw errorFrom(errors, `Withdrawal of '${unit.name}' failed.`)
}

/** Releases a unit or an invocation. Returns `false` when it is already withdrawn. */
export function releasePresent(unit: UnitNode): boolean {
  return untracked(() => {
    // A stale registration cannot change the unit or a newer unit in the same slot.
    if (!unit.signals.present())
      return false

    batch(() => releaseUnit(unit))
    return true
  })
}
