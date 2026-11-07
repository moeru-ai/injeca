import type { DecideFor, DecisionFor, DependencyHook, HookResult, UnitHook } from '../primitives/decision'
import type { Container } from './container'
import type { DependencyMap, OptionalValue } from './keys'
import type { DependencyChange, DependencySnapshot, OwnerRecord, SetStatusOptions, UnitStatus } from './unit'

type HookDependency<V> = [Exclude<V, undefined>] extends [OptionalValue<infer T>] ? DependencySnapshot<T> | undefined : DependencySnapshot<V>

/** The snapshot of a dependency hook: each dependency with its value, `instanceId`, and effective status. An optional dependency can be `undefined`. */
export type HookDependencies<D> = D extends DependencyMap
  ? { readonly [K in keyof D]: HookDependency<D[K]> }
  : Readonly<Record<string, DependencySnapshot<unknown> | undefined>>

export type Disposer = () => void | Promise<void>

export type EffectSetup = () => Disposer | void

/** The context that each hook handler gets. */
export interface HookContext<H extends UnitHook> {
  /** Creates the decisions that this hook accepts. Each decision is bound to this run. */
  readonly decide: DecideFor<H>
  /** The number of the current run of this hook for this instance. The first run is `1`. A requeue adds one. */
  readonly attempt: number
  /** The last decision of this hook for this instance. */
  readonly previous: DecisionFor<H> | undefined
  /** Aborts when a newer target supersedes this run, or when the instance is disposed. */
  readonly signal: AbortSignal
}

/** The context of `dependency-change` and `dependency-status-change`. */
export interface DependencyHookContext<H extends DependencyHook, D = undefined> extends HookContext<H> {
  /** The current snapshot of all dependencies. Decide from it, not from one change only. */
  readonly dependsOn: HookDependencies<D>
  /** The difference between the last handled snapshot and the current snapshot. */
  readonly changes: readonly DependencyChange[]
}

export type HookContextFor<H extends UnitHook, D = undefined> = H extends DependencyHook ? DependencyHookContext<H, D> : HookContext<H>

export type HookHandler<H extends UnitHook = UnitHook, D = undefined> = (context: HookContextFor<H, D>) => HookResult<H> | Promise<HookResult<H>>

/** The lifecycle members that `build` and an invocation callback get. */
export interface LifecycleContext<D = undefined> {
  /** Registers a hook. It is valid only while `build` or the callback runs. A later call throws `hook-outside-build`. */
  on: <H extends UnitHook>(hook: H, handler: HookHandler<H, D>) => void
  /** Runs `setup` and stores the returned disposer on the instance. */
  effect: (setup: EffectSetup) => void
  /** Aborts when a newer target supersedes the build, or when the instance is disposed. */
  signal: AbortSignal
}

export type BuildContext<D extends DependencyMap | undefined = undefined> = {
  container: Container
  name: string
  /** The id of the instance that this build creates. */
  instanceId: string
  /** The owner record of the consumer container, when the unit has `instances: 'per-container'`. */
  consumer?: OwnerRecord
  /**
   * Sets the own status of the instance. It stays valid after `build` returns.
   * After the instance is disposed, a call has no effect and goes to the observe stream.
   */
  setStatus: (status: UnitStatus, reasonOrOptions?: string | SetStatusOptions) => void
} & LifecycleContext<D> & (D extends undefined ? { dependsOn?: unknown } : { dependsOn: D })

export type InvocationContext<D = undefined> = LifecycleContext<D>
