import type { ConditionalDependency, DependencyMap, FallbackDependency, InferProvided, KeyOptions, OptionalDependency, ProvidedBy, ProvidedKey, ResolutionCondition } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { conditionBrand, fallbackBrand, optionalBrand } from '../types'

type KeyLike<T = unknown> = ProvidedKey<string, T, DependencyMap | undefined> | ProvidedBy<T>

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.trim() !== name)
    throw new InvalidArgumentError(`A key name must be a non-empty string without outer whitespace. Got ${JSON.stringify(name)}.`)
}

function readKeyOptions(options: unknown): boolean {
  if (options === undefined)
    return false
  if (typeof options !== 'object' || options === null)
    throw new InvalidArgumentError('The options of defineKey must be an object.')

  let exclusive: unknown
  try {
    exclusive = (options as KeyOptions).exclusive
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the options of defineKey.', { cause: error })
  }
  if (exclusive !== undefined && typeof exclusive !== 'boolean')
    throw new InvalidArgumentError('The exclusive option of defineKey must be a boolean.')

  return exclusive === true
}

/**
 * Creates a typed key without a provider. A consumer can depend on it now. `provide(key, ...)` registers a provider later.
 *
 * With `options.exclusive`, the key can have only one provider in its resolution area. Two or more providers all go to `conflict`.
 */
export function defineKey<T>(name: string, options?: KeyOptions): ProvidedKey<string, T, undefined> {
  assertName(name)
  return readKeyOptions(options) ? Object.freeze({ key: name, exclusive: true }) : Object.freeze({ key: name })
}

/** Tells whether a key from `provide` or `defineKey` is exclusive. A name is not. Reading a caller-owned property happens once, inside a narrow `try`. */
export function isExclusiveKey(key: unknown): boolean {
  if (typeof key !== 'object' || key === null)
    return false

  try {
    return (key as KeyOptions).exclusive === true
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the exclusive property of the key.', { cause: error })
  }
}

export function normalizeName(nameOrProvidedKey: string | ProvidedKey<any, any, any>): string {
  if (typeof nameOrProvidedKey === 'object' && nameOrProvidedKey !== null && 'key' in nameOrProvidedKey) {
    return (nameOrProvidedKey as ProvidedKey<any, any, any>).key as string
  }

  return nameOrProvidedKey as string
}

const optionalMarkers = new WeakSet<object>()
const fallbackMarkers = new WeakSet<object>()
const conditionMarkers = new WeakSet<object>()

export function isConditionalDependency(value: unknown): value is ConditionalDependency<unknown> {
  return typeof value === 'object' && value !== null && conditionMarkers.has(value)
}

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

function optionalMarker<T>(dependencies: readonly string[], condition: ResolutionCondition | undefined): OptionalDependency<T> {
  const marker: OptionalDependency<T> = Object.freeze({ [optionalBrand]: true as const, dependencies, ...(condition ? { condition } : {}) })
  optionalMarkers.add(marker)

  return marker
}

/**
 * Marks an optional dependency. The dependent gets `{ value, status }`, or `undefined` when no provider runs.
 * It also accepts a `firstAvailable` marker and a `where` marker.
 */
export function optional<T>(dependency: KeyLike<T> | FallbackDependency<T> | ConditionalDependency<T>): OptionalDependency<T> {
  if (isFallbackDependency(dependency))
    return optionalMarker(dependency.dependencies, undefined)
  if (isConditionalDependency(dependency))
    return optionalMarker(dependency.dependencies, dependency.condition)

  const name = normalizeName(dependency as KeyLike<T>)
  assertName(name)
  return optionalMarker(Object.freeze([name]), undefined)
}

/**
 * Adds a resolution condition to a dependency. The condition gets the key, the owner, and the metadata of the provider.
 *
 * If it returns `false`, the dependency does not resolve. A required dependency keeps the dependent `pending`. An optional one is `undefined`.
 * The condition must be pure and synchronous. A thrown error counts as `false` and goes to the observe stream.
 * Wrap the result in `optional()`, or pass an `optional()` marker, to combine the two.
 */
export function where<T>(dependency: OptionalDependency<T>, condition: ResolutionCondition): OptionalDependency<T>
export function where<T>(dependency: KeyLike<T>, condition: ResolutionCondition): ConditionalDependency<T>
export function where<T>(dependency: KeyLike<T> | OptionalDependency<T>, condition: ResolutionCondition): ConditionalDependency<T> | OptionalDependency<T> {
  if (typeof condition !== 'function')
    throw new InvalidArgumentError('The condition of where() is not a function.')
  if (isOptionalDependency(dependency)) {
    if (dependency.condition)
      throw new InvalidArgumentError('The optional dependency already has a condition.')
    return optionalMarker<T>(dependency.dependencies, condition)
  }
  if (isFallbackDependency(dependency) || isConditionalDependency(dependency))
    throw new InvalidArgumentError('where() accepts a key, a name, or an optional() marker.')

  const name = normalizeName(dependency as KeyLike<T>)
  assertName(name)
  const marker: ConditionalDependency<T> = Object.freeze({ [conditionBrand]: true as const, dependencies: Object.freeze([name]), condition })
  conditionMarkers.add(marker)

  return marker
}

export function isOptionalDependency(value: unknown): value is OptionalDependency<unknown> {
  return typeof value === 'object' && value !== null && optionalMarkers.has(value)
}
