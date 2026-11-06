import type { WritableSignal } from '../../helpers/signals'
import type { ContainerNode, Runtime, ServiceNode } from '../graph'

import { computed, signal } from 'alien-signals'

import { areaOf } from './exports'

/** Tells whether `ancestor` is `container` or an ancestor of it, with no container in between that isolates `keyName`. */
function reaches(container: ContainerNode, ancestor: ContainerNode, keyName: string): boolean {
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    if (current === ancestor)
      return true
    if (current.isolated.has(keyName))
      return false
  }

  return false
}

/**
 * Tells whether two containers share a resolution area of `keyName`.
 * A resolution area is the container that has the key, with its descendants that do not isolate the key.
 * For an exported registration, the caller passes the parent container. See `areaOf`.
 */
export function sameArea(a: ContainerNode, b: ContainerNode, keyName: string): boolean {
  return reaches(a, b, keyName) || reaches(b, a, keyName)
}

/** The published services of `keyName` in all containers of the runtime. */
export function declarationsOf(runtime: Runtime, keyName: string): WritableSignal<ReadonlySet<ServiceNode>> {
  let declarations = runtime.declarations.get(keyName)
  if (!declarations) {
    declarations = signal<ReadonlySet<ServiceNode>>(new Set())
    runtime.declarations.set(keyName, declarations)
  }

  return declarations
}

export function addDeclaration(service: ServiceNode): void {
  const declarations = declarationsOf(service.container.runtime, service.name)
  if (!declarations().has(service))
    declarations(new Set([...declarations(), service]))
}

export function removeDeclaration(service: ServiceNode): void {
  const declarations = declarationsOf(service.container.runtime, service.name)
  if (declarations().has(service))
    declarations(new Set([...declarations()].filter(other => other !== service)))
}

function sameList(a: readonly ServiceNode[], b: readonly ServiceNode[]): boolean {
  return a.length === b.length && a.every((service, index) => service === b[index])
}

const none: readonly ServiceNode[] = Object.freeze([])

/**
 * Creates the conflict of a service: the other present declarations of its key in the same resolution area, when the key is exclusive.
 *
 * The result depends only on the set of declarations. The order of the registrations has no effect.
 * Only one registration of a key exists in one container, so a rival is always in another container.
 * An exported registration counts in the resolution area of its parent container. So two sibling exports of one exclusive key conflict, and an export conflicts with a registration of the parent.
 * A service of a `perConsumer` registration has no conflict of its own. It follows the conflict of its registration.
 */
export function createRivals(service: ServiceNode): () => readonly ServiceNode[] {
  if (service.template)
    return () => service.template?.signals.rivals() ?? none
  if (service.kind !== 'service')
    return () => none

  return computed<readonly ServiceNode[]>((previous) => {
    const rivals = [...declarationsOf(service.container.runtime, service.name)()]
      .filter(other => other.container !== service.container
        && other.signals.present()
        && (service.exclusive || other.exclusive)
        && sameArea(areaOf(service), areaOf(other), service.name))
      .sort((a, b) => a.seq - b.seq)

    return previous && sameList(previous, rivals) ? previous : rivals
  })
}

/** Tells whether the key of the service has more than one declaration in its resolution area. */
export function inConflict(service: ServiceNode): boolean {
  return service.signals.rivals().length > 0
}
