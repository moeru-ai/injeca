import type { CleanupContext, CleanupFrame } from '../helpers/cleanup-context'
import type { Clock } from '../helpers/clock'
import type { Deferred } from '../helpers/deferred'
import type { DeliveryQueue } from '../helpers/delivery-queue'
import type { ReactiveOwner, WritableSignal } from '../helpers/signals'
import type { Decision, DecisionKind, ServiceHook } from '../primitives/decision'
import type { Container, DependencyState, Disposer, EffectSetup, ObserveRecord, OwnerRecord, ServicePhase, ServiceStatus, SetStatusOptions, StatusCause } from '../types'

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
}

/** An own status or an effective status, with its reason and cause. */
export interface StatusValue {
  readonly status: ServiceStatus
  readonly reason?: string
  readonly cause?: StatusCause
}

/** The resolution of one declared edge. Only a `running` provider resolves. */
export type Resolution
  = | { readonly kind: 'missing' }
    | { readonly kind: 'not-running', readonly provider: ServiceNode }
    | { readonly kind: 'resolved', readonly provider: ServiceNode, readonly instance: InstanceNode }

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
  /** The services that hold this instance. The reconciler writes it. */
  readonly holders: WritableSignal<ReadonlySet<ServiceNode>>
  /** The own status that `setStatus` writes. */
  readonly own: WritableSignal<StatusValue>
}

export interface InstanceNode {
  readonly id: string
  readonly service: ServiceNode
  /** The provider instances that this instance is bound to, by local dependency name. A dependency hook can move a binding. */
  readonly bindings: Map<string, InstanceNode>
  /** Provider instances that a running dependency hook holds in addition to the bindings. */
  readonly extraHolds: Set<InstanceNode>
  /** The provider instances that this instance is registered as a holder of. */
  readonly held: Set<InstanceNode>
  readonly hooks: Readonly<Record<ServiceHook, RawHookHandler[]>>
  readonly hookStates: Map<ServiceHook, HookState>
  /** The last handled snapshot, by local dependency name. */
  handled: ReadonlyMap<string, DependencyState | undefined>
  readonly effects: Disposer[]
  readonly controller: AbortController
  readonly signals: InstanceSignals
  /** The controller of the hook run in progress. It aborts when a newer target supersedes the run. */
  hookRun: AbortController | undefined
  /** The waiting run of a dependency hook requeue. A service never has more than one. */
  requeueWait: { readonly cancel: () => void } | undefined
  value: unknown
  /** `true` while `build` runs. `on` is valid only then. */
  building: boolean
  disposed: boolean
}

/** The context that the reconciler creates for each build. The build function of a service adapts it. */
export interface RawBuildContext {
  readonly container: Container
  readonly name: string
  readonly instanceId: string
  readonly dependsOn: Readonly<Record<string, unknown>>
  readonly on: (hook: ServiceHook, handler: RawHookHandler) => void
  readonly effect: (setup: EffectSetup) => void
  readonly signal: AbortSignal
  readonly setStatus: (status: ServiceStatus, reasonOrOptions?: string | SetStatusOptions) => void
}

export type BuildFunction = (context: RawBuildContext) => unknown

/**
 * - `service`: one `provide` call. It has a value and a key.
 * - `invocation`: one `invoke` call. It is a service without a value and without a key.
 * - `resolver`: one pending `resolve` call. It withdraws itself after it reads its dependencies.
 */
export type ServiceKind = 'service' | 'invocation' | 'resolver'

/** What the service does after its current instance stops. */
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

/** The reactive state of a service. The reconciler and the registration write the first four. The others are computed values. */
export interface ServiceSignals {
  readonly present: WritableSignal<boolean>
  readonly phase: WritableSignal<ServicePhase>
  readonly instance: WritableSignal<InstanceNode | undefined>
  /** `true` when a `resolve` call or an active dependent needs the service before `start()`. */
  readonly demanded: WritableSignal<boolean>
  /** `true` when the service converges: its container is started, or something demands it. */
  readonly active: () => boolean
  readonly serving: () => boolean
  readonly resolutions: ReadonlyMap<string, () => Resolution>
  /** The effective status. It is `undefined` outside `running`. */
  readonly effective: () => StatusValue | undefined
  /** `true` when a newer target supersedes the current run: the service is withdrawn or stopped, or a required dependency is withdrawn. */
  readonly targetLost: () => boolean
}

export interface ServiceNode {
  readonly seq: number
  readonly kind: ServiceKind
  readonly name: string
  readonly container: ContainerNode
  readonly edges: readonly DependencyEdge[]
  readonly build: BuildFunction
  /** Increments when the service gets new options. Part of the epoch. */
  revision: number
  readonly signals: ServiceSignals

  // Reconciler state. Only the reconciler reads and writes it.
  busy: boolean
  stopIntent: StopIntent
  parkedEpoch: string | undefined
  /** The error that moved the service to `failed`. */
  failure: { readonly error: unknown } | undefined
  /** The teardown errors that the withdrawal reports. */
  readonly teardownErrors: unknown[]
  /** Resolves with the teardown errors when the service is `withdrawn`. */
  readonly withdrawal: Deferred<readonly unknown[]>
  /** The effective status that the observe stream reported last. */
  reportedStatus: StatusValue | undefined
  disposeEffects: () => void
}

/** The reactive state of a container. */
export interface ContainerSignals {
  /** `true` between `start()` and `stop()`. */
  readonly started: WritableSignal<boolean>
  /** The current service for each key name. */
  readonly slots: Map<string, WritableSignal<ServiceNode | undefined>>
}

export interface ContainerNode {
  readonly seq: number
  readonly api: Container
  readonly owner: OwnerRecord
  readonly parent: ContainerNode | undefined
  readonly runtime: Runtime
  readonly children: Set<ContainerNode>
  /** All services and invocations of the container that are not `withdrawn`, with the services that leave. */
  readonly services: Set<ServiceNode>
  readonly signals: ContainerSignals
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
  markDirty: (service: ServiceNode) => void
  /** Calls `listener` each time the work queue drains. Returns a function that removes it. */
  onDrained: (listener: () => void) => () => void
  /** Calls `listener` after each teardown with its errors. Returns a function that removes it. */
  onTeardown: (listener: (service: ServiceNode, errors: readonly unknown[]) => void) => () => void
  /** Calls the teardown listeners. Only the stop transition calls it. */
  notifyTeardown: (service: ServiceNode, errors: readonly unknown[]) => void
  /** Schedules a drain, so that the drained listeners run at least once. */
  requestDrain: () => void
}

/** One `observe` subscription. It gets the records of its container and of the child containers. */
export interface Observer {
  readonly container: ContainerNode
  readonly callback: (record: ObserveRecord) => void
  active: boolean
}

/** The state that all containers of one tree share. The transitions read it from `service.container.runtime`. */
export interface Runtime {
  readonly clock: Clock
  readonly context: CleanupContext
  /** Delivers observe records and watch states in order. */
  readonly deliveries: DeliveryQueue
  readonly observers: Set<Observer>
  readonly reconciler: Reconciler
  nextSeq: () => number
  nextInstanceId: () => string
}
