import type { DependencyDeclarations, DependencyMap, KeyReference, ProvidedKey, ResolveDependencyDeclaration } from './keys'
import type { ProvideOption, ProvideOptionWithKeys, Registration } from './options'

export interface DeclareOptions {
  /** The declared edges. A later `tx.provide` without `dependsOn` uses them. */
  dependsOn?: DependencyDeclarations
  /** An optional declaration does not need a `tx.provide`. Without one, the commit drops it. */
  optional?: boolean
}

/** The `provide` of a transaction. It takes a name or a key, as `provide` does. */
export interface TransactionProvide {
  <T, Key extends string, Deps extends DependencyDeclarations>(name: Key, option: ProvideOptionWithKeys<T, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
  <D extends DependencyMap | undefined, T = unknown, Key extends string = string>(name: Key, option: ProvideOption<T, D>): Registration<Key, T, D>
  <T, Key extends string, Deps extends DependencyDeclarations>(key: ProvidedKey<Key, T, DependencyMap | undefined>, option: ProvideOptionWithKeys<NoInfer<T>, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
  <T, Key extends string>(key: ProvidedKey<Key, T, DependencyMap | undefined>, option: ProvideOption<NoInfer<T>, undefined>): Registration<Key, T, undefined>
}

/** The `replace` of a transaction. It takes the current registration of the key at the commit. */
export interface TransactionReplace {
  <T, Deps extends DependencyDeclarations>(key: ProvidedKey<string, T, DependencyMap | undefined> | string, option: ProvideOptionWithKeys<NoInfer<T>, Deps>): void
  <T>(key: ProvidedKey<string, T, DependencyMap | undefined> | string, option: ProvideOption<NoInfer<T>, undefined>): void
}

/**
 * A set of registrations that publish together. `transaction(container)` creates it.
 *
 * Nothing is visible to consumers before `commit()`. A failed build publishes nothing.
 */
export interface Transaction {
  /** Reserves a service. Graph queries see it as `declared`. Consumers cannot resolve it. */
  readonly declare: (key: KeyReference, options?: DeclareOptions) => void
  /** Fills a declared service, or adds a new service. The registration becomes current at the commit. */
  readonly provide: TransactionProvide
  /** Replaces the current registration of `key` in the container at the commit, as `replace()` does. */
  readonly replace: TransactionReplace
  /**
   * Builds the services in dependency order, then publishes them in one batch. Then the `start` hooks run.
   *
   * A service whose required dependencies are not available goes to `pending`. That is not a failure.
   * If one build fails, nothing publishes, no `start` hook runs, and the promise rejects with the build error.
   * Resolves after the publish. It does not wait for the `start` hooks.
   */
  readonly commit: () => Promise<void>
  /** Removes all declared and built services of the transaction. A build that settles later cannot publish. */
  readonly abort: () => Promise<void>
}
