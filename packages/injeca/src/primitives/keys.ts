import type { DependencyMap, FallbackDependency, InferProvided, OptionalDependency, ProvidedBy, ProvidedKey } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { fallbackBrand, optionalBrand } from '../types'

type KeyLike<T = unknown> = ProvidedKey<string, T, DependencyMap | undefined> | ProvidedBy<T>

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.trim() !== name)
    throw new InvalidArgumentError(`A key name must be a non-empty string without outer whitespace. Got ${JSON.stringify(name)}.`)
}

/**
 * Creates a typed key without a provider. A consumer can depend on it now. `provide(key, ...)` registers a provider later.
 */
export function defineKey<T>(name: string): ProvidedKey<string, T, undefined> {
  assertName(name)
  return Object.freeze({ key: name })
}

export function normalizeName(nameOrProvidedKey: string | ProvidedKey<any, any, any>): string {
  if (typeof nameOrProvidedKey === 'object' && nameOrProvidedKey !== null && 'key' in nameOrProvidedKey) {
    return (nameOrProvidedKey as ProvidedKey<any, any, any>).key as string
  }

  return nameOrProvidedKey as string
}

const optionalMarkers = new WeakSet<object>()
const fallbackMarkers = new WeakSet<object>()

export function isFallbackDependency(value: unknown): value is FallbackDependency<unknown> {
  return typeof value === 'object' && value !== null && fallbackMarkers.has(value)
}

/**
 * Marks a fallback dependency. It resolves to the first provider in the list whose effective status is available.
 *
 * A change of the selection is a change of identity: the dependent gets `dependency-change`.
 * It is required, unless it is wrapped in `optional()`.
 */
export function firstAvailable<const Keys extends readonly KeyLike[]>(...keys: Keys): FallbackDependency<InferProvided<Keys[number]>> {
  if (keys.length === 0)
    throw new InvalidArgumentError('firstAvailable() needs at least one key.')

  const dependencies = keys.map((key) => {
    const name = normalizeName(key)
    assertName(name)
    return name
  })
  if (new Set(dependencies).size !== dependencies.length)
    throw new InvalidArgumentError(`firstAvailable() got the same key more than once: ${dependencies.join(', ')}.`)

  const marker: FallbackDependency<InferProvided<Keys[number]>> = Object.freeze({ [fallbackBrand]: true as const, dependencies: Object.freeze(dependencies) })
  fallbackMarkers.add(marker)

  return marker
}

/**
 * Marks an optional dependency. The dependent gets `{ value, status }`, or `undefined` when no provider runs.
 * It also accepts a `firstAvailable` marker.
 */
export function optional<T>(dependency: KeyLike<T> | FallbackDependency<T>): OptionalDependency<T> {
  let dependencies: readonly string[]
  if (isFallbackDependency(dependency)) {
    dependencies = dependency.dependencies
  }
  else {
    const name = normalizeName(dependency as KeyLike<T>)
    assertName(name)
    dependencies = Object.freeze([name])
  }

  const marker: OptionalDependency<T> = Object.freeze({ [optionalBrand]: true as const, dependencies })
  optionalMarkers.add(marker)

  return marker
}

export function isOptionalDependency(value: unknown): value is OptionalDependency<unknown> {
  return typeof value === 'object' && value !== null && optionalMarkers.has(value)
}
