import type { ProvidedKey, ResolutionCondition } from '../../types'
import type { DependencyEdge } from '../graph'

import { InvalidArgumentError } from '../../diagnostics/errors'
import { isConditionalDependency, isFallbackDependency, isOptionalDependency, normalizeName } from '../../primitives/keys'

function edgeOf(name: string, candidates: readonly string[], optional: boolean, fallback: boolean, condition?: ResolutionCondition, candidateConditions?: Readonly<Record<string, ResolutionCondition>>): DependencyEdge {
  return Object.freeze({
    name,
    keyName: candidates.join(' | '),
    candidates,
    optional,
    fallback,
    ...(condition ? { condition } : {}),
    ...(candidateConditions ? { candidateConditions } : {}),
  })
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
      return edgeOf(name, dependency.dependencies, true, dependency.dependencies.length > 1, dependency.condition, dependency.candidateConditions)
    if (isConditionalDependency(dependency))
      return edgeOf(name, dependency.dependencies, false, false, dependency.condition)
    if (isFallbackDependency(dependency))
      return edgeOf(name, dependency.dependencies, false, true, dependency.condition, dependency.candidateConditions)
    if (typeof dependency === 'string' || (typeof dependency === 'object' && dependency !== null && 'key' in dependency)) {
      const keyName = normalizeName(dependency as string | ProvidedKey<string, unknown, undefined>)
      if (typeof keyName === 'string' && keyName.length > 0)
        return edgeOf(name, Object.freeze([keyName]), false, false)
    }

    throw new InvalidArgumentError(`The dependency '${name}' of '${owner}' is not a name, a key, an optional marker, a fallback marker, or a condition marker.`)
  }))
}
