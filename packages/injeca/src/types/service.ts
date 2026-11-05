export type OwnerValue = string | number | boolean | null | readonly OwnerValue[] | { readonly [key: string]: OwnerValue }

/** A serializable record that names the owner of a container. injeca does not interpret its fields. */
export interface OwnerRecord {
  readonly [key: string]: OwnerValue
}

/**
 * The phase of a service.
 *
 * - `declared`: a transaction reserved the service. Consumers cannot resolve it.
 * - `pending`: the service waits until its required dependencies are available, or for `start()`. It runs no code.
 * - `conflict`: an exclusive key has more than one declaration in one resolution area. It runs no code.
 * - `building`: `build` runs. The instance is not visible.
 * - `starting`: the instance is published. The `start` hooks run.
 * - `retrying`: a `start` hook returned `requeue`. The service keeps its instance and its dependencies, and waits for the next attempt. It is not available.
 * - `running`: the instance serves calls. Only this phase has a status.
 * - `stopping`: the service waits until its holders release it. Then the `stop` hooks and the effect disposers run.
 * - `failed`: a build failed, a hook returned `fail`, retries ended, or a timeout failed. `start()` or `replace()` moves the service out of it.
 * - `withdrawn`: the registration is withdrawn and the instance is disposed.
 */
export type ServicePhase = 'declared' | 'pending' | 'conflict' | 'building' | 'starting' | 'retrying' | 'running' | 'stopping' | 'failed' | 'withdrawn'

/**
 * The status of a running instance.
 *
 * - `ready`: the service works at full quality.
 * - `degraded`: every call completes, at lower quality.
 * - `unavailable`: the instance exists, but calls fail now.
 */
export type ServiceStatus = 'ready' | 'degraded' | 'unavailable'

/** One link of a cause chain. A remote plugin uses it to report a cause inside the plugin. */
export interface StatusCause {
  readonly key: string
  readonly owner: OwnerRecord
  readonly status: ServiceStatus
  readonly reason?: string
  readonly cause?: StatusCause
}

/** The second argument of `setStatus` in its object form. */
export interface SetStatusOptions {
  readonly reason?: string
  readonly cause?: StatusCause
}

/** The identity and the effective status of one resolved dependency. */
export interface DependencyState {
  /** The key name of the provider. For `firstAvailable`, it is the selected key. */
  readonly provider: string
  readonly instanceId: string
  readonly status: ServiceStatus
}

/** One dependency in the snapshot of a dependency hook. */
export interface DependencySnapshot<T> extends DependencyState {
  readonly value: T
}

/** The difference of one dependency between the last handled snapshot and the current snapshot. `undefined` means no provider. */
export interface DependencyChange {
  /** The local name in `dependsOn`. */
  readonly key: string
  readonly from: DependencyState | undefined
  readonly to: DependencyState | undefined
}

/** The state that `watch` sends. `phase` is `undefined` when no provider exists for the key. */
export interface ServiceState {
  readonly phase: ServicePhase | undefined
  /** The effective status. It is `undefined` outside `running`. */
  readonly status: ServiceStatus | undefined
  readonly instanceId: string | undefined
  readonly reason?: string
  readonly cause?: StatusCause
}

/**
 * One reason why a service is not `running`, or why it is not available.
 *
 * - `missing-provider`: no container in the resolution chain has a provider for a required key.
 * - `failed-dependency`: the provider of a required key is in `failed`.
 * - `pending-dependency`: the provider of a required key exists, but it does not run yet.
 * - `unavailable-dependency`: the provider of a required key runs, but its effective status is `unavailable`. `cause` starts the cause chain.
 * - `rejected-provider`: a resolution condition rejected the provider of a required key. `owner` and `metadata` name the provider.
 * - `conflicting-dependency`: the provider of a required key is an exclusive key with more than one declaration.
 * - `conflict`: the service itself is an exclusive key with more than one declaration. `owners` lists the owner of each declaration.
 * - `failed`: the service itself is in `failed`.
 * - `retrying`: a `start` hook of the service returned `requeue`. `attempt` is the attempt that requeued, and `reason` is its reason.
 * - `not-started`: the container of the service is not started, and nothing demands the service.
 */
export type ServiceBlocker
  = | { readonly kind: 'missing-provider', readonly dependency: string, readonly key: string }
    | { readonly kind: 'failed-dependency', readonly dependency: string, readonly key: string, readonly error: unknown }
    | { readonly kind: 'pending-dependency', readonly dependency: string, readonly key: string, readonly phase: ServicePhase }
    | { readonly kind: 'unavailable-dependency', readonly dependency: string, readonly key: string, readonly cause: StatusCause }
    | { readonly kind: 'rejected-provider', readonly dependency: string, readonly key: string, readonly owner: OwnerRecord, readonly metadata: Readonly<Record<string, unknown>> }
    | { readonly kind: 'conflicting-dependency', readonly dependency: string, readonly key: string, readonly owners: readonly OwnerRecord[] }
    | { readonly kind: 'conflict', readonly key: string, readonly owners: readonly OwnerRecord[] }
    | { readonly kind: 'failed', readonly error: unknown }
    | { readonly kind: 'retrying', readonly attempt: number, readonly reason?: string }
    | { readonly kind: 'not-started' }

/** Why a service or an invocation is not `running`, or why it is not available. `graph(container).explain()` returns it. */
export interface ServiceExplanation {
  readonly name: string
  readonly kind: 'service' | 'invocation'
  readonly owner: OwnerRecord
  /** The phase of the service. It is `undefined` for a key without a service. Then `owner` is the owner of the container of the query. */
  readonly phase: ServicePhase | undefined
  /** The effective status of a running service. */
  readonly status?: ServiceStatus
  readonly reason?: string
  /** The cause chain of the effective status. */
  readonly cause?: StatusCause
  readonly blockers: readonly ServiceBlocker[]
}
