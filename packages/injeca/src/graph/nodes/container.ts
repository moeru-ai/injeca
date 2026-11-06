import type { Container } from '../../types'
import type { ContainerNode, ServiceNode } from '../graph'

import { BuildAfterDisposeError, InvalidArgumentError } from '../../diagnostics/errors'
import { errorFrom } from '../../helpers/error-from'
import { batch, untracked } from '../../helpers/signals'
import { addDeclaration } from '../resolvers/exclusive'
import { exportsOf } from '../resolvers/exports'
import { slotOf } from '../resolvers/resolvers'

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
 * Adds an exported service to the exports of its parent container, in container creation order.
 * It takes the place of an earlier service of the same container, for example at the swap of a replacement.
 */
function addExport(service: ServiceNode): void {
  const parent = service.container.parent
  if (!service.exported || !parent)
    return

  const exports = exportsOf(parent, service.name)
  const current = exports()
  if (current.includes(service))
    return

  exports(Object.freeze([...current.filter(other => other.container !== service.container), service].sort((a, b) => a.container.seq - b.container.seq)))
}

function removeExport(service: ServiceNode): void {
  const parent = service.container.parent
  if (!service.exported || !parent)
    return

  const exports = exportsOf(parent, service.name)
  if (exports().includes(service))
    exports(Object.freeze(exports().filter(other => other !== service)))
}

/**
 * Makes `service` visible to consumers: the slot of its key, or the consumer map of its `perConsumer` registration.
 * An exported service is also visible in the resolution area of the parent container.
 * An exclusive conflict counts each published service with a key.
 */
export function publishService(service: ServiceNode): void {
  const { template } = service
  if (template) {
    const consumers = template.signals.consumers()
    if (consumers.get(service.container) !== service)
      template.signals.consumers(new Map([...consumers, [service.container, service]]))
    return
  }

  slotOf(service.container, service.name)(service)
  addExport(service)
  addDeclaration(service)
}

/**
 * Clears the slot and marks the service absent. The reconciler stops it after its holders release it.
 * A `perConsumer` registration also releases the service of each consumer container.
 */
export function releaseService(service: ServiceNode): void {
  service.signals.present(false)
  if (service.kind !== 'service' || service.template)
    return

  for (const consumer of service.signals.consumers().values())
    consumer.signals.present(false)

  const slot = slotOf(service.container, service.name)
  if (slot() === service)
    slot(undefined)
  removeExport(service)
}

/** Waits until `service` is `withdrawn`. Rejects with its teardown errors. */
export async function awaitWithdrawal(service: ServiceNode): Promise<void> {
  const errors = await service.withdrawal.promise
  if (errors.length > 0)
    throw errorFrom(errors, `Withdrawal of '${service.name}' failed.`)
}

/** Releases a service or an invocation. Returns `false` when it is already withdrawn. */
export function releasePresent(service: ServiceNode): boolean {
  return untracked(() => {
    // A stale registration cannot change the service or a newer service in the same slot.
    if (!service.signals.present())
      return false

    batch(() => releaseService(service))
    return true
  })
}
