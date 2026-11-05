import type { ProvidedKey } from '../../types'
import type { DependencyEdge } from '../graph'

import { InvalidArgumentError } from '../../diagnostics/errors'
import { isFallbackDependency, isOptionalDependency, normalizeName } from '../../primitives/keys'

function edgeOf(name: string, candidates: readonly string[], optional: boolean, fallback: boolean): DependencyEdge {
  return Object.freeze({ name, keyName: candidates.join(' | '), candidates, optional, fallback })
}

/**
 * Reads a `dependsOn` declaration into edges. Reading a caller-owned property happens once, inside a narrow `try`.
 */
export function readEdges(owner: string, dependsOn: unknown): readonly DependencyEdge[] {
  if (dependsOn === undefined || dependsOn === null)
    return Object.freeze([])
  if (typeof dependsOn !== 'object')
    throw new InvalidArgumentError(`The dependsOn option of '${owner}' is not an object.`)

  let entries: [string, unknown][]
  try {
    entries = Object.entries(dependsOn)
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the dependsOn option of '${owner}'.`, { cause: error })
  }

  return Object.freeze(entries.map(([name, dependency]): DependencyEdge => {
    if (isOptionalDependency(dependency))
      return edgeOf(name, dependency.dependencies, true, dependency.dependencies.length > 1)
    if (isFallbackDependency(dependency))
      return edgeOf(name, dependency.dependencies, false, true)
    if (typeof dependency === 'string' || (typeof dependency === 'object' && dependency !== null && 'key' in dependency)) {
      const keyName = normalizeName(dependency as string | ProvidedKey<string, unknown, undefined>)
      if (typeof keyName === 'string' && keyName.length > 0)
        return edgeOf(name, Object.freeze([keyName]), false, false)
    }

    throw new InvalidArgumentError(`The dependency '${name}' of '${owner}' is not a name, a key, an optional marker, or a fallback marker.`)
  }))
}
