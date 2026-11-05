import type { OwnerRecord, ServiceStatus } from './service'

declare const providedType: unique symbol
declare const optionalType: unique symbol
declare const fallbackType: unique symbol
declare const conditionalType: unique symbol

export const optionalBrand: unique symbol = Symbol('injeca.optional')
export const fallbackBrand: unique symbol = Symbol('injeca.fallback')
export const conditionBrand: unique symbol = Symbol('injeca.condition')

export type DependencyMap = Record<string, any>

/**
 * A typed identity for a service. `provide` and `defineKey` return one.
 */
export interface ProvidedKey<Key, T, _D extends DependencyMap | undefined> {
  key: Key
  /** `true` for a key from `defineKey(name, { exclusive: true })`. Only one provider can exist in its resolution area. */
  readonly exclusive?: boolean
  /** Carries the value type. It has no value at run time. */
  readonly [providedType]?: T
}

/** A key name, a key from `defineKey`, or the result of `provide`. */
export type KeyReference = string | ProvidedKey<string, unknown, DependencyMap | undefined>

export interface KeyOptions {
  /** Makes an exclusive key. Two or more providers in one resolution area all go to `conflict`. */
  readonly exclusive?: boolean
}

/** A frozen record on a registration. Resolution conditions and graph queries read it. */
export type ServiceMetadata = Readonly<Record<string, unknown>>

/** The read-only information about a provider that a resolution condition gets. */
export interface ProviderInfo {
  /** The key name of the provider. */
  readonly key: string
  /** The owner record of the container of the provider. */
  readonly owner: OwnerRecord
  readonly metadata: ServiceMetadata
}

/** A resolution condition from `where`. It must be pure and synchronous. A thrown error counts as `false`. */
export type ResolutionCondition = (provider: ProviderInfo) => boolean

export type ProvidedBy<T> = string & { __providedType?: T }

/** A dependency marker from `optional(key)`. A missing provider gives `undefined` and does not keep the dependent `pending`. */
export interface OptionalDependency<T> {
  readonly [optionalBrand]: true
  /** The names of the keys, in order. More than one name comes from `optional(firstAvailable(...))`. */
  readonly dependencies: readonly string[]
  /** The resolution condition from `where`, when the marker has one. */
  readonly condition?: ResolutionCondition
  /** Carries the value type. It has no value at run time. */
  readonly [optionalType]?: T
}

/** A required dependency marker from `where(key, condition)`. A provider that the condition rejects does not resolve. */
export interface ConditionalDependency<T> {
  readonly [conditionBrand]: true
  /** The name of the key. */
  readonly dependencies: readonly string[]
  readonly condition: ResolutionCondition
  /** Carries the value type. It has no value at run time. */
  readonly [conditionalType]?: T
}

/** A fallback dependency marker from `firstAvailable(...keys)`. It resolves to the first available provider in the list. */
export interface FallbackDependency<T> {
  readonly [fallbackBrand]: true
  /** The names of the keys, in order of preference. */
  readonly dependencies: readonly string[]
  /** Carries the value type. It has no value at run time. */
  readonly [fallbackType]?: T
}

/** One value of a `dependsOn` declaration: a name, a key, an optional marker, a fallback marker, or a condition marker. */
export type DependencyDeclaration = string | ProvidedKey<string, unknown, DependencyMap | undefined> | OptionalDependency<unknown> | FallbackDependency<unknown> | ConditionalDependency<unknown>

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
      : Deps[K] extends ConditionalDependency<infer T>
        ? T
        : Deps[K] extends ProvidedKey<any, infer T, any>
          ? T
          : Deps[K] extends ProvidedBy<infer T>
            ? T
            : any
}
