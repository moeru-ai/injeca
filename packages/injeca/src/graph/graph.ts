import type { CleanupContext, CleanupFrame } from '../helpers/cleanup-context'
import type { Clock } from '../helpers/clock'
import type { Deferred } from '../helpers/deferred'
import type { DeliveryQueue } from '../helpers/delivery-queue'
import type { ReactiveOwner, WritableSignal } from '../helpers/signals'
import type { Decision, DecisionKind, UnitHook } from '../primitives/decision'
import type { Container, DependencyState, Disposer, EffectSetup, HookTimeouts, ListenerMetadata, ObserveRecord, OwnerRecord, ResolutionCondition, SetStatusOptions, StatusCause, TimeoutHandler, UnitMetadata, UnitPhase, UnitStatus } from '../types'

// The data model of the graph. The node types refer to each other, so they are in one file.
// The functions for each node kind are in `nodes/`. Resolution is in `resolvers/`. Status is in `status.ts`.

export interface DependencyEdge {
  /** The local name in `dependsOn`. */
  readonly name: string
  /** The names of the keys that the edge resolves, joined for messages. */
  readonly keyName: string
  /** The names of the keys, in order. A plain edge has one. A `firstAvailable` edge has its list. */
  readonly candidates: readonly string[]
  readonly optional: boolean
  readonly fallback: boolean
  /** The resolution condition from `where`. It filters each candidate. */
  readonly condition?: ResolutionCondition
  /** The resolution conditions of single candidates, from `firstAvailable(where(key, condition), ...)`, by key name. */
  readonly candidateConditions?: Readonly<Record<string, ResolutionCondition>>
}

/** The retry and timeout options of one registration or one container, read once from the caller. */
export interface Policy {
  readonly maxAttempts?: number
  readonly timeouts?: Readonly<HookTimeouts>
  readonly onTimeout?: TimeoutHandler
}

/** An own status or an effective status, with its reason and cause. */
export interface StatusValue {
  readonly status: UnitStatus
  readonly reason?: string
  readonly cause?: StatusCause
}

/**
 * The resolution of one declared edge. Only a `running` provider resolves.
 *
 * - `rejected`: a resolution condition rejected the provider.
 * - `conflict`: the provider is an exclusive key with more than one declaration. `rivals` are the other declarations.
 */
export type Resolution
  = | { readonly kind: 'missing' }
    | { readonly kind: 'not-running', readonly provider: UnitNode }
    | { readonly kind: 'rejected', readonly provider: UnitNode }
    | { readonly kind: 'conflict', readonly provider: UnitNode, readonly rivals: readonly UnitNode[] }
    | { readonly kind: 'resolved', readonly provider: UnitNode, readonly instance: InstanceNode }

/** A hook handler as the reconciler stores it. The public `on` overloads check the types. */
export type RawHookHandler = (context: object) => unknown

/** The run state of one hook for one instance. */
export interface HookState {
  /** The attempt of the next run. A requeue adds one. Another decision resets it to `1`. */
  attempt: number
  previous: Decision | undefined
}

/** The reactive state of an instance. */
export interface InstanceSignals {
  /** The units that hold this instance. The reconciler writes it. */
  readonly holders: WritableSignal<ReadonlySet<UnitNode>>
  /** The own status that `setStatus` writes. */
  readonly own: WritableSignal<StatusValue>
}

export interface InstanceNode {
  readonly id: string
  readonly unit: UnitNode
  /** The provider instances that this instance is bound to, by local dependency name. A dependency hook can move a binding. */
  readonly bindings: Map<string, InstanceNode>
  /** Provider instances that a running dependency hook holds in addition to the bindings. */
  readonly extraHolds: Set<InstanceNode>
  /** The provider instances that this instance is registered as a holder of. */
  readonly held: Set<InstanceNode>
  readonly hooks: Readonly<Record<UnitHook, RawHookHandler[]>>
  readonly hookStates: Map<UnitHook, HookState>
  /** The last handled snapshot, by local dependency name. */
  handled: ReadonlyMap<string, DependencyState | undefined>
  readonly effects: Disposer[]
  readonly controller: AbortController
  readonly signals: InstanceSignals
  /** The controller of the hook run in progress. It aborts when a newer target supersedes the run. */
  hookRun: AbortController | undefined
  /** The waiting run of a requeue, of a `start` hook or of a dependency hook. A unit never has more than one. */
  requeueWait: { readonly cancel: () => void } | undefined
  /** The index of the `start` handler that the next attempt runs first. A requeue keeps the handlers before it as done. */
  startFrom: number
  value: unknown
  /** `true` while `build` runs. `on` is valid only then. */
  building: boolean
  /** `true` from the start of the teardown. A re-entrant call finds the cleanups of the instance by it. */
  tearingDown: boolean
  disposed: boolean
}

/**
 * The consumer side of a resolution: a unit, or a read such as `peek` that has no unit.
 * `scope` is the container that the edges resolve from. `container` gets the observe records.
 */
export type ResolutionConsumer = Pick<UnitNode, 'container' | 'scope' | 'name' | 'template'>

/** The context that the reconciler creates for each build. The build function of a unit adapts it. */
export interface RawBuildContext {
  readonly container: Container
  readonly name: string
  readonly instanceId: string
  readonly dependsOn: Readonly<Record<string, unknown>>
  readonly on: (hook: UnitHook, handler: RawHookHandler) => void
  readonly effect: (setup: EffectSetup) => void
  readonly signal: AbortSignal
  readonly setStatus: (status: UnitStatus, reasonOrOptions?: string | SetStatusOptions) => void
  /** The owner record of the consumer container of a per-container instance. */
  readonly consumer?: OwnerRecord
}

export type BuildFunction = (context: RawBuildContext) => unknown

/** The options of one registration, read once from the caller. `provide`, `replace`, and transactions share it. */
export interface UnitDefinition {
  readonly edges: readonly DependencyEdge[]
  readonly build: BuildFunction
  readonly metadata: UnitMetadata
  readonly instances: 'shared' | 'per-container'
  /** `'parent'` when the registration is a candidate for consumers in the resolution area of the parent container. */
  readonly visibility: 'local' | 'parent'
  readonly policy: Policy
}

/** The state behind the result of one `provide` call. */
export interface RegistrationNode {
  readonly container: ContainerNode
  readonly name: string
  readonly exclusive: boolean
  /** The published unit. It is `undefined` before a transaction commits. */
  current: UnitNode | undefined
  /** The new unit of a `replace` call that waits for its swap. */
  pending: UnitNode | undefined
}

/**
 * How a replacement ended.
 *
 * - `swapped`: the new instance took over.
 * - `failed`: the build or the start of the new instance failed. The old instance did not change.
 * - `stopping`: the unit started to stop before the swap.
 * - `cancelled`: a newer `replace` or a withdrawal superseded the replacement.
 */
export type SwapOutcome
  = | { readonly kind: 'swapped' }
    | { readonly kind: 'failed', readonly error: unknown }
    | { readonly kind: 'stopping' }
    | { readonly kind: 'cancelled' }

/** The state of a new unit that replaces `target` after it completes `start`. */
export interface SwapState {
  readonly target: UnitNode
  /** Settles the `replace` call. Only the first call has an effect. */
  readonly settle: (outcome: SwapOutcome) => void
  /**
   * Set for a consumer unit of a per-container replacement. The unit does not swap in alone when it completes `start`.
   * It calls `ready`, and the replacement swaps all consumer units in one batch.
   */
  readonly ready?: (unit: UnitNode) => void
  /** `true` after the unit completed `start` and waits for the batch swap of its replacement. */
  held: boolean
  /** `true` for the successor of a make-before-break rebuild. It has the options of `target`. */
  readonly rebuild?: boolean
}

/**
 * - `unit`: one `provide` call. It has a value and a key.
 * - `invocation`: one `invoke` call. It is a unit without a value and without a key.
 * - `resolver`: one pending `resolve` call. It withdraws itself after it reads its dependencies.
 */
export type UnitKind = 'unit' | 'invocation' | 'resolver'

/** What the unit does after its current instance stops. */
export interface StopIntent {
  /** Go to `failed` with this error. */
  failure?: { readonly error: unknown }
  /** Stay `pending` until the epoch changes. */
  parkEpoch?: string
  /** The reason for the observe stream. */
  reason?: string
  /** The decision that caused the stop, for the observe stream. */
  decision?: DecisionKind
}

/** The reactive state of a unit. The reconciler and the registration write the first four. The others are computed values. */
export interface UnitSignals {
  readonly present: WritableSignal<boolean>
  readonly phase: WritableSignal<UnitPhase>
  readonly instance: WritableSignal<InstanceNode | undefined>
  /** `true` when a `resolve` call or an active dependent needs the unit before `start()`. */
  readonly demanded: WritableSignal<boolean>
  /** The `watch` and `waitFor` subscriptions that demand a consumer unit of a per-container registration. A subscription removes itself when it ends. `stop()` clears the set. */
  readonly subscribers: WritableSignal<ReadonlySet<object>>
  /** `true` when the unit converges: its container is started, or something demands it. */
  readonly active: () => boolean
  readonly serving: () => boolean
  readonly resolutions: ReadonlyMap<string, () => Resolution>
  /** The effective status. It is `undefined` outside `running`. */
  readonly effective: () => StatusValue | undefined
  /** The other declarations of an exclusive key in the resolution area. The unit is in conflict when the list is not empty. */
  readonly rivals: () => readonly UnitNode[]
  /** The instances of a per-container unit, by consumer container. Only the reconciler writes it. */
  readonly consumers: WritableSignal<ReadonlyMap<ContainerNode, UnitNode>>
  /** `true` when a newer target supersedes the current run: the unit is withdrawn or stopped, a required dependency is withdrawn, or the key is in conflict. */
  readonly targetLost: () => boolean
}

export interface UnitNode {
  readonly seq: number
  readonly kind: UnitKind
  readonly name: string
  readonly container: ContainerNode
  /**
   * The container that the edges of the unit resolve from. It is the container of the registration.
   * A consumer unit of a per-container registration lives in the consumer container, but its edges resolve from the container of its registration, as for a plain registration.
   */
  readonly scope: ContainerNode
  readonly edges: readonly DependencyEdge[]
  readonly build: BuildFunction
  readonly metadata: UnitMetadata
  readonly policy: Policy
  /** `true` when the key of the unit is exclusive. */
  readonly exclusive: boolean
  /**
   * `'parent'` for a parent-visible registration. It lives in its container, and it is also a candidate for consumers in the resolution area of the parent container.
   * A consumer unit of a per-container registration is always `'local'`. It lives in the consumer container.
   */
  readonly visibility: 'local' | 'parent'
  /** `'per-container'` for the registration of a per-container unit. It never builds. Each consumer container gets its own unit. */
  readonly instances: 'shared' | 'per-container'
  /** The per-container registration that this consumer unit belongs to. A replacement of the registration moves it. */
  template: UnitNode | undefined
  /** The owner record of the consumer container of a per-container unit. */
  readonly consumer: OwnerRecord | undefined
  /** The registration of a unit with a key. A replacement keeps it. */
  registration: RegistrationNode | undefined
  /** Set while this unit waits to replace another unit. */
  swap: SwapState | undefined
  /** The unit that replaced this one. */
  replacedBy: UnitNode | undefined
  /**
   * The new unit that waits to replace this one, until the swap or the end of the replacement.
   * It comes from `replace()`, from a transaction, or from a make-before-break rebuild. For a per-container registration, it is the new registration.
   */
  successor: UnitNode | undefined
  /** The transaction that builds this unit. The reconciler does not touch the unit until the transaction ends. */
  transaction: TransactionNode | undefined
  /** Increments when the unit gets new options. Part of the epoch. */
  revision: number
  readonly signals: UnitSignals

  // Reconciler state. Only the reconciler reads and writes it.
  busy: boolean
  stopIntent: StopIntent
  parkedEpoch: string | undefined
  /** The error that moved the unit to `failed`. */
  failure: { readonly error: unknown } | undefined
  /**
   * The demanders of a consumer unit that already got a build since the unit last reached `running`.
   * A failed consumer unit builds again on the demand of a new demander, but not again for the same demander. So a waiting dependent cannot cause a retry loop.
   */
  readonly demanders: Set<object>
  /** The teardown errors that the withdrawal reports. */
  readonly teardownErrors: unknown[]
  /** Resolves with the teardown errors when the unit is `withdrawn`. */
  readonly withdrawal: Deferred<readonly unknown[]>
  /** The effective status that the observe stream reported last. */
  reportedStatus: StatusValue | undefined
  disposeEffects: () => void
}

/** One listener of the listener registry. */
export interface ListenerRecord {
  readonly seq: number
  readonly handler: unknown
  readonly metadata: ListenerMetadata
}

/** One key of an open transaction. */
export interface TransactionEntry {
  readonly name: string
  /** The edges of `tx.declare`. */
  declared: readonly DependencyEdge[] | undefined
  optional: boolean
  /** The definition of `tx.provide` or `tx.replace`. */
  definition: UnitDefinition | undefined
  /** `true` for `tx.replace`. */
  replace: boolean
  /** The registration that `tx.replace` names, when it got a registration and not a name. */
  target: RegistrationNode | undefined
  /** The registration that `tx.provide` returned. */
  registration: RegistrationNode | undefined
  exclusive: boolean
  /** `'parent'` when `tx.provide` makes the key visible to the parent. The reservation of an exclusive key then counts in the resolution area of the parent container. */
  visibility: 'local' | 'parent'
  /** The declaration that reserves an exclusive key until the commit or the abort. See `nodes/reservation.ts`. */
  reservation: UnitNode | undefined
}

export interface TransactionNode {
  readonly container: ContainerNode
  state: 'open' | 'committing' | 'done' | 'aborted'
  readonly entries: Map<string, TransactionEntry>
  /** The error that a commit rejects with after an abort. */
  abortError: unknown
  /** The controllers of the builds in progress. An abort aborts them. */
  readonly controllers: Set<AbortController>
  /** Settles when the commit or the abort ends. */
  settled: Promise<void> | undefined
}

/** The reactive state of a container. */
export interface ContainerSignals {
  /** `true` between `start()` and `stop()`. */
  readonly started: WritableSignal<boolean>
  /** The current unit for each key name. */
  readonly slots: Map<string, WritableSignal<UnitNode | undefined>>
  /** The current parent-visible units of the child containers for each key name, in container creation order. */
  readonly childUnits: Map<string, WritableSignal<readonly UnitNode[]>>
}

export interface ContainerNode {
  readonly seq: number
  readonly api: Container
  readonly owner: OwnerRecord
  readonly parent: ContainerNode | undefined
  readonly runtime: Runtime
  readonly children: Set<ContainerNode>
  /** All units and invocations of the container that are not `withdrawn`, with the units that leave. */
  readonly units: Set<UnitNode>
  readonly signals: ContainerSignals
  /** The key names that do not resolve from the ancestors. */
  readonly localKeys: ReadonlySet<string>
  /** The retry and timeout options of `createContainer`. */
  readonly policy: Policy
  /** The listener registry, by event id. */
  readonly listeners: Map<string, ListenerRecord[]>
  /** The transactions that did not end. A disposal aborts them. */
  readonly transactions: Set<TransactionNode>
  readonly effects: Disposer[]
  readonly reactiveOwner: ReactiveOwner
  readonly stopReactive: () => void
  /** `true` after `start()` got this container. Then `start()` and `stop()` of an ancestor apply to it too. */
  enrolled: boolean
  state: 'active' | 'disposing' | 'disposed'
  frame: CleanupFrame | undefined
  disposal: Promise<void> | undefined
  /** Called once when the disposal settles. Subscriptions use it. */
  readonly disposedListeners: Set<() => void>
}

/** The execution layer. The graph calls it. `reconciler/reconciler.ts` implements it. */
export interface Reconciler {
  markDirty: (unit: UnitNode) => void
  /** Calls `listener` each time the work queue drains. Returns a function that removes it. */
  onDrained: (listener: () => void) => () => void
  /** Calls `listener` after each teardown with its errors. Returns a function that removes it. */
  onTeardown: (listener: (unit: UnitNode, errors: readonly unknown[]) => void) => () => void
  /** Calls the teardown listeners. Only the stop transition calls it. */
  notifyTeardown: (unit: UnitNode, errors: readonly unknown[]) => void
  /** Schedules a drain, so that the drained listeners run at least once. */
  requestDrain: () => void
}

/** One `observe` subscription. It gets the records of its container and of the child containers. */
export interface Observer {
  readonly container: ContainerNode
  readonly callback: (record: ObserveRecord) => void
  active: boolean
}

/** The state that all containers of one tree share. The transitions read it from `unit.container.runtime`. */
export interface Runtime {
  readonly clock: Clock
  /** The random source for the backoff jitter. It returns a number from 0 up to, but not including, 1. */
  readonly random: () => number
  readonly context: CleanupContext
  /** Delivers observe records and watch states in order. */
  readonly deliveries: DeliveryQueue
  readonly observers: Set<Observer>
  /** The published units with a key, by key name, in all containers. Exclusive conflicts read it. */
  readonly declarations: Map<string, WritableSignal<ReadonlySet<UnitNode>>>
  readonly reconciler: Reconciler
  nextSeq: () => number
  nextInstanceId: () => string
}
