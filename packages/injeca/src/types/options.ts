import type { BuildContext, InvocationContext } from './context'
import type { DependencyDeclarations, DependencyMap, ProvidedKey, ResolveDependencyDeclaration, ServiceMetadata } from './keys'
import type { PolicyOptions } from './policy'

/** The registration options that each object form of `provide` accepts. */
export interface RegistrationOptions extends PolicyOptions {
  /** A record that resolution conditions and graph queries read. injeca freezes a copy. */
  metadata?: ServiceMetadata
  /**
   * Runs `build` once for each consumer container. The build context then has `consumer`.
   * Each instance disposes with its consumer container.
   */
  perConsumer?: boolean
}

export type ProvideOptionObject<T, D extends DependencyMap | undefined = undefined> = { build: (context: BuildContext<D>) => T | Promise<T> } & RegistrationOptions & (D extends undefined ? { dependsOn?: Record<string, never> } : { dependsOn: { [K in keyof D]: string } })
export type ProvideOptionFunc<T, D extends DependencyMap | undefined = undefined> = (context: BuildContext<D>) => T | Promise<T>
export type ProvideOption<T, D extends DependencyMap | undefined = undefined> = ProvideOptionObject<T, D> | ProvideOptionFunc<T, D>

export interface ProvideOptionObjectWithKeys<T, Deps extends DependencyDeclarations> extends RegistrationOptions {
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
 * The `replace()` of a registration. It takes the function shorthand, or the object form with or without `dependsOn`.
 * An option without `metadata`, `maxAttempts`, `timeouts`, or `onTimeout` keeps that value of the registration. `perConsumer` does not change.
 */
export interface ReplaceFunction<T> {
  <Deps extends DependencyDeclarations>(option: ProvideOptionWithKeys<T, Deps>): Promise<boolean>
  (option: ProvideOption<T, undefined>): Promise<boolean>
}

/**
 * The result of `provide`: the typed key of the service, with `withdraw()` and `replace()`.
 */
export interface Registration<Key, T, D extends DependencyMap | undefined> extends ProvidedKey<Key, T, D> {
  /**
   * Withdraws the service. Dependents stop first. Then the service runs its `stop` hooks and effect disposers.
   *
   * Resolves `false` for a stale registration and does not change any service. Rejects with the teardown errors.
   */
  readonly withdraw: () => Promise<boolean>
  /**
   * Replaces the instance of the service without a gap.
   *
   * The old instance keeps serving with its status while the new instance runs `build` and `start`. The swap is one batch.
   * Resolves `true` after the swap. Resolves `false` for a stale registration, or when a newer `replace` or a withdrawal supersedes this call.
   * Rejects with the build or start error of the new instance, and the old instance does not change.
   * Rejects with `replace-while-stopping` when the service is in `stopping`.
   */
  readonly replace: ReplaceFunction<T>
}

/** The result of `invoke`. */
export interface InvocationHandle {
  /** Withdraws the invocation. Resolves `false` when it is already withdrawn. Rejects with the teardown errors. */
  readonly withdraw: () => Promise<boolean>
}
