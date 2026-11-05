import type { BuildContext, InvocationContext } from './context'
import type { DependencyDeclarations, DependencyMap, ProvidedKey, ResolveDependencyDeclaration } from './keys'

export type ProvideOptionObject<T, D extends DependencyMap | undefined = undefined> = { build: (context: BuildContext<D>) => T | Promise<T> } & (D extends undefined ? { dependsOn?: Record<string, never> } : { dependsOn: { [K in keyof D]: string } })
export type ProvideOptionFunc<T, D extends DependencyMap | undefined = undefined> = (context: BuildContext<D>) => T | Promise<T>
export type ProvideOption<T, D extends DependencyMap | undefined = undefined> = ProvideOptionObject<T, D> | ProvideOptionFunc<T, D>

export interface ProvideOptionObjectWithKeys<T, Deps extends DependencyDeclarations> {
  build: (context: BuildContext<ResolveDependencyDeclaration<Deps>>) => T | Promise<T>
  dependsOn: Deps
}
export type ProvideOptionWithKeys<T, Deps extends DependencyDeclarations> = ProvideOptionObjectWithKeys<T, Deps>

export type InvokeOptionObject<D extends DependencyMap | undefined = undefined> = { callback: (dependencies: D, context: InvocationContext<D>) => void | Promise<void> } & (D extends undefined ? { dependsOn?: Record<string, never> } : { dependsOn: { [K in keyof D]: string } })
export type InvokeOptionFunc<D extends DependencyMap | undefined = undefined> = (dependencies: D, context: InvocationContext<D>) => void | Promise<void>
export type InvokeOption<D extends DependencyMap | undefined = undefined> = InvokeOptionObject<D> | InvokeOptionFunc<D>

export interface InvokeOptionObjectWithKeys<Deps extends DependencyDeclarations> {
  callback: (dependencies: ResolveDependencyDeclaration<Deps>, context: InvocationContext<ResolveDependencyDeclaration<Deps>>) => void | Promise<void>
  dependsOn: Deps
}
export type InvokeOptionWithKeys<Deps extends DependencyDeclarations> = InvokeOptionObjectWithKeys<Deps>

/**
 * The result of `provide`: the typed key of the service, with `withdraw()`.
 */
export interface Registration<Key, T, D extends DependencyMap | undefined> extends ProvidedKey<Key, T, D> {
  /**
   * Withdraws the service. Dependents stop first. Then the service runs its `stop` hooks and effect disposers.
   *
   * Resolves `false` for a stale registration and does not change any service. Rejects with the teardown errors.
   */
  readonly withdraw: () => Promise<boolean>
}

/** The result of `invoke`. */
export interface InvocationHandle {
  /** Withdraws the invocation. Resolves `false` when it is already withdrawn. Rejects with the teardown errors. */
  readonly withdraw: () => Promise<boolean>
}
