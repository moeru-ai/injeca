import type { ServiceMetadata } from '../../types'
import type { BuildFunction, Policy, ServiceDefinition } from '../graph'

import { InvalidArgumentError } from '../../diagnostics/errors'
import { readEdges } from './edge'
import { readPolicy } from './policy'

const emptyMetadata: ServiceMetadata = Object.freeze({})

function readMetadata(name: string, metadata: unknown, fallback: ServiceMetadata | undefined): ServiceMetadata {
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
 * A replacement keeps `perConsumer` and `export` of its registration, so it ignores these fields of the definition.
 */
export function readDefinition(name: string, option: unknown, inherit?: { readonly metadata: ServiceMetadata, readonly policy: Policy }): ServiceDefinition {
  let build: unknown
  let dependsOn: unknown
  let metadata: unknown
  let perConsumer: unknown
  let exported: unknown
  let policy: { maxAttempts: unknown, timeouts: unknown, onTimeout: unknown }
  try {
    const object: { build?: unknown, dependsOn?: unknown, metadata?: unknown, perConsumer?: unknown, export?: unknown, maxAttempts?: unknown, timeouts?: unknown, onTimeout?: unknown } = typeof option === 'function'
      ? { build: option }
      : typeof option === 'object' && option !== null ? option : {}
    build = object.build
    dependsOn = object.dependsOn
    metadata = object.metadata
    perConsumer = object.perConsumer
    exported = object.export
    policy = { maxAttempts: object.maxAttempts, timeouts: object.timeouts, onTimeout: object.onTimeout }
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the provide options of '${name}'.`, { cause: error })
  }
  if (typeof build !== 'function')
    throw new InvalidArgumentError(`The build option of '${name}' is not a function.`)
  if (perConsumer !== undefined && typeof perConsumer !== 'boolean')
    throw new InvalidArgumentError(`The perConsumer option of '${name}' must be a boolean.`)
  if (exported !== undefined && typeof exported !== 'boolean')
    throw new InvalidArgumentError(`The export option of '${name}' must be a boolean.`)

  return {
    edges: readEdges(name, dependsOn),
    build: build as BuildFunction,
    metadata: readMetadata(name, metadata, inherit?.metadata),
    perConsumer: perConsumer === true,
    exported: exported === true,
    policy: readPolicy(`'${name}'`, policy, inherit?.policy),
  }
}
