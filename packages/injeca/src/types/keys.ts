import type { ServiceStatus } from './service'

declare const providedType: unique symbol
declare const optionalType: unique symbol
declare const fallbackType: unique symbol

export const optionalBrand: unique symbol = Symbol('injeca.optional')
export const fallbackBrand: unique symbol = Symbol('injeca.fallback')

export type DependencyMap = Record<string, any>

/**
 * A typed identity for a service. `provide` and `defineKey` return one.
 */
export interface ProvidedKey<Key, T, _D extends DependencyMap | undefined> {
  key: Key
  /** Carries the value type. It has no value at run time. */
  readonly [providedType]?: T
}

export type ProvidedBy<T> = string & { __providedType?: T }

/** A dependency marker from `optional(key)`. A missing provider gives `undefined` and does not keep the dependent `pending`. */
export interface OptionalDependency<T> {
  readonly [optionalBrand]: true
  /** The names of the keys, in order. More than one name comes from `optional(firstAvailable(...))`. */
  readonly dependencies: readonly string[]
  /** Carries the value type. It has no value at run time. */
  readonly [optionalType]?: T
}

/** A fallback dependency marker from `firstAvailable(...keys)`. It resolves to the first available provider in the list. */
export interface FallbackDependency<T> {
  readonly [fallbackBrand]: true
  /** The names of the keys, in order of preference. */
  readonly dependencies: readonly string[]
  /** Carries the value type. It has no value at run time. */
  readonly [fallbackType]?: T
}

/** One value of a `dependsOn` declaration: a name, a key, an optional marker, or a fallback marker. */
export type DependencyDeclaration = string | ProvidedKey<string, unknown, DependencyMap | undefined> | OptionalDependency<unknown> | FallbackDependency<unknown>

export type DependencyDeclarations = Record<string, DependencyDeclaration>

/** The resolved value of an optional dependency. */
export interface OptionalValue<T> {
  readonly value: T
  readonly status: ServiceStatus
}

export type InferProvided<T>
  = T extends ProvidedKey<any, infer P, any>
    ? P
    : T extends ProvidedBy<infer P>
      ? P
      : never

/** A required dependency is its value. An optional dependency is `{ value, status }` or `undefined`. */
export type ResolveDependencyDeclaration<Deps extends DependencyDeclarations> = {
  [K in keyof Deps]: Deps[K] extends OptionalDependency<infer T>
    ? OptionalValue<T> | undefined
    : Deps[K] extends FallbackDependency<infer T>
      ? T
      : Deps[K] extends ProvidedKey<any, infer T, any>
        ? T
        : Deps[K] extends ProvidedBy<infer T>
          ? T
          : any
}
