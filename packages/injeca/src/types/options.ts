import type { BuildContext, InvocationContext } from './context'
import type { DependencyDeclarations, DependencyMap, ProvidedKey, ResolveDependencyDeclaration, UnitMetadata } from './keys'
import type { PolicyOptions } from './policy'

/** The registration options that each object form of `provide` accepts. */
export interface RegistrationOptions extends PolicyOptions {
  /** A record that resolution conditions and graph queries read. injeca freezes a copy. */
  metadata?: UnitMetadata
  /**
   * How many instances the registration builds. The default is `'shared'`: one instance for all consumers.
   * `'per-container'` runs `build` once for each consumer container. The build context then has `consumer`.
   * Each instance disposes with its consumer container.
   */
  instances?: 'shared' | 'per-container'
  /**
   * Where consumers see the registration. The default is `'local'`: its container and the descendants of its container.
   * `'parent'` makes the registration visible one level up. The registration stays in its container: its owner, its disposal, its dependencies, and its phases.
   * It is also a candidate for consumers in the resolution area of the parent container: the parent and each descendant of the parent.
   * For an exclusive key, it counts as a declaration in that area. On a root container, it has no effect.
   */
  visibility?: 'local' | 'parent'
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
 * An option without `metadata`, `maxAttempts`, `timeouts`, or `onTimeout` keeps that value of the registration. `instances` and `visibility` do not change.
 */
export interface ReplaceFunction<T> {
  <Deps extends DependencyDeclarations>(option: ProvideOptionWithKeys<T, Deps>, options?: ReplaceOptions): Promise<boolean>
  (option: ProvideOption<T, undefined>, options?: ReplaceOptions): Promise<boolean>
}

/** The options of `replace()`. */
export interface ReplaceOptions {
  /**
   * Cancels the pending replacement when the signal aborts, as a newer `replace` does. The old instance stays, and `replace()` rejects.
   * A timeout reason (`name === 'TimeoutError'`) rejects with `wait-timeout`, with the reason as `cause`. Its message tells what the new instance waits for.
   * Another reason rejects as it is. An aborted signal rejects at once and changes nothing. After the swap, the signal has no effect. There is no default.
   */
  signal?: AbortSignal
}

/** The options of `withdraw()` of a registration or an invocation. */
export interface WithdrawOptions {
  /**
   * Ends the wait when the signal aborts, and rejects with the reason. The withdrawal continues. There is no default.
   * The unit gets a `wait-aborted` record in the observe stream when it did not finish its withdrawal. An aborted signal still starts the withdrawal.
   */
  signal?: AbortSignal
}

/**
 * The result of `provide`: the typed key of the unit, with `withdraw()` and `replace()`.
 */
export interface Registration<Key, T, D extends DependencyMap | undefined> extends ProvidedKey<Key, T, D> {
  /**
   * Withdraws the unit. Dependents stop first. Then the unit runs its `stop` hooks and effect disposers.
   *
   * Resolves `false` for a stale registration and does not change any unit. Rejects with the teardown errors.
   *
   * A call from a cleanup that the withdrawal waits for cannot wait: of the unit, of a consumer unit of it, or of a unit that holds it.
   * injeca finds such a call by the signal of the cleanup, or by the synchronous part of the cleanup. It warns, sends a `reentrant-call` record, and resolves `true` at once. The withdrawal continues.
   */
  readonly withdraw: (options?: WithdrawOptions) => Promise<boolean>
  /**
   * Replaces the instance of the unit without a gap.
   *
   * The old instance keeps serving with its status while the new instance runs `build` and `start`. The swap is one batch.
   * Resolves `true` after the swap. Resolves `false` for a stale registration, or when a newer `replace` or a withdrawal supersedes this call.
   * Rejects with the build or start error of the new instance, and the old instance does not change.
   * Rejects when `options.signal` aborts before the swap. See `ReplaceOptions.signal`.
   * Rejects with `replace-while-stopping` when the unit is in `stopping`.
   */
  readonly replace: ReplaceFunction<T>
}

/** The result of `invoke`. */
export interface InvocationHandle {
  /** The name of the invocation. Graph queries, for example `graph(container).dependencies(key)` and `explain(key)`, accept it. */
  readonly key: string
  /** Withdraws the invocation. Resolves `false` when it is already withdrawn. Rejects with the teardown errors. `options` work as for `withdraw()` of a registration. */
  readonly withdraw: (options?: WithdrawOptions) => Promise<boolean>
}
