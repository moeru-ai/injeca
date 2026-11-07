import type { WritableSignal } from '../../helpers/signals'
import type { ContainerNode, Runtime, UnitNode } from '../graph'

import { computed, signal } from 'alien-signals'

import { areaOf } from './visibility'

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
 * For a parent-visible registration, the caller passes the parent container. See `areaOf`.
 */
export function sameArea(a: ContainerNode, b: ContainerNode, keyName: string): boolean {
  return reaches(a, b, keyName) || reaches(b, a, keyName)
}

/** The published units of `keyName` in all containers of the runtime. */
export function declarationsOf(runtime: Runtime, keyName: string): WritableSignal<ReadonlySet<UnitNode>> {
  let declarations = runtime.declarations.get(keyName)
  if (!declarations) {
    declarations = signal<ReadonlySet<UnitNode>>(new Set())
    runtime.declarations.set(keyName, declarations)
  }

  return declarations
}

export function addDeclaration(unit: UnitNode): void {
  const declarations = declarationsOf(unit.container.runtime, unit.name)
  if (!declarations().has(unit))
    declarations(new Set([...declarations(), unit]))
}

export function removeDeclaration(unit: UnitNode): void {
  const declarations = declarationsOf(unit.container.runtime, unit.name)
  if (declarations().has(unit))
    declarations(new Set([...declarations()].filter(other => other !== unit)))
}

function sameList(a: readonly UnitNode[], b: readonly UnitNode[]): boolean {
  return a.length === b.length && a.every((unit, index) => unit === b[index])
}

const none: readonly UnitNode[] = Object.freeze([])

/**
 * Creates the conflict of a unit: the other present declarations of its key in the same resolution area, when the key is exclusive.
 *
 * The result depends only on the set of declarations. The order of the registrations has no effect.
 * Only one registration of a key exists in one container, so a rival is always in another container.
 * A parent-visible registration counts in the resolution area of its parent container. So two parent-visible registrations of one exclusive key in sibling containers conflict, and a parent-visible registration conflicts with a registration of the parent.
 * A unit of a per-container registration has no conflict of its own. It follows the conflict of its registration.
 */
export function createRivals(unit: UnitNode): () => readonly UnitNode[] {
  if (unit.template)
    return () => unit.template?.signals.rivals() ?? none
  if (unit.kind !== 'unit')
    return () => none

  return computed<readonly UnitNode[]>((previous) => {
    const rivals = [...declarationsOf(unit.container.runtime, unit.name)()]
      .filter(other => other.container !== unit.container
        && other.signals.present()
        && (unit.exclusive || other.exclusive)
        && sameArea(areaOf(unit), areaOf(other), unit.name))
      .sort((a, b) => a.seq - b.seq)

    return previous && sameList(previous, rivals) ? previous : rivals
  })
}

/** Tells whether the key of the unit has more than one declaration in its resolution area. */
export function inConflict(unit: UnitNode): boolean {
  return unit.signals.rivals().length > 0
}
