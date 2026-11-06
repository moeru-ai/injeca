import type { UnitMetadata } from '../../types'
import type { BuildFunction, Policy, UnitDefinition } from '../graph'

import { InvalidArgumentError } from '../../diagnostics/errors'
import { readEdges } from './edge'
import { readPolicy } from './policy'

const emptyMetadata: UnitMetadata = Object.freeze({})

function readMetadata(name: string, metadata: unknown, fallback: UnitMetadata | undefined): UnitMetadata {
  if (metadata === undefined)
    return fallback ?? emptyMetadata
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
    throw new InvalidArgumentError(`The metadata option of '${name}' must be a record.`)

  try {
    return Object.freeze({ ...metadata })
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the metadata option of '${name}'.`, { cause: error })
  }
}

/**
 * Reads the options of one registration once: the function shorthand, or the object form.
 * Reading caller-owned properties happens inside a narrow `try`. `inherit` gives the metadata and each policy field when the options have none.
 * A replacement keeps `instances` and `visibility` of its registration, so it ignores these fields of the definition.
 */
export function readDefinition(name: string, option: unknown, inherit?: { readonly metadata: UnitMetadata, readonly policy: Policy }): UnitDefinition {
  let build: unknown
  let dependsOn: unknown
  let metadata: unknown
  let instances: unknown
  let visibility: unknown
  let policy: { maxAttempts: unknown, timeouts: unknown, onTimeout: unknown }
  try {
    const object: { build?: unknown, dependsOn?: unknown, metadata?: unknown, instances?: unknown, visibility?: unknown, maxAttempts?: unknown, timeouts?: unknown, onTimeout?: unknown } = typeof option === 'function'
      ? { build: option }
      : typeof option === 'object' && option !== null ? option : {}
    build = object.build
    dependsOn = object.dependsOn
    metadata = object.metadata
    instances = object.instances
    visibility = object.visibility
    policy = { maxAttempts: object.maxAttempts, timeouts: object.timeouts, onTimeout: object.onTimeout }
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the provide options of '${name}'.`, { cause: error })
  }
  if (typeof build !== 'function')
    throw new InvalidArgumentError(`The build option of '${name}' is not a function.`)
  if (instances !== undefined && instances !== 'shared' && instances !== 'per-container')
    throw new InvalidArgumentError(`The instances option of '${name}' must be 'shared' or 'per-container'.`)
  if (visibility !== undefined && visibility !== 'local' && visibility !== 'parent')
    throw new InvalidArgumentError(`The visibility option of '${name}' must be 'local' or 'parent'.`)

  return {
    edges: readEdges(name, dependsOn),
    build: build as BuildFunction,
    metadata: readMetadata(name, metadata, inherit?.metadata),
    instances: instances === 'per-container' ? 'per-container' : 'shared',
    visibility: visibility === 'parent' ? 'parent' : 'local',
    policy: readPolicy(`'${name}'`, policy, inherit?.policy),
  }
}
