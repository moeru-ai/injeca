import type { Container } from './container'
import type { KeyReference, ServiceMetadata } from './keys'
import type { OwnerRecord, ServiceExplanation, ServicePhase, ServiceStatus } from './service'

/** One service, invocation, or declared service in a graph query result. */
export interface GraphService {
  /** The key name of the service, or the name of the invocation. */
  readonly key: string
  readonly kind: 'service' | 'invocation'
  /** The owner record of the container of the service. */
  readonly owner: OwnerRecord
  readonly phase: ServicePhase
  /** The effective status of a running service. */
  readonly status?: ServiceStatus
  readonly instanceId?: string
  readonly metadata: ServiceMetadata
  readonly exclusive: boolean
  readonly perConsumer: boolean
  /** The owner record of the consumer container of a `perConsumer` instance. */
  readonly consumer?: OwnerRecord
}

/**
 * How a declared edge resolves now.
 *
 * - `resolved`: a running provider serves the edge.
 * - `not-running`: a provider exists, but it does not run.
 * - `missing`: no provider exists.
 * - `rejected`: a resolution condition rejected the provider.
 * - `conflict`: the provider is an exclusive key with more than one declaration.
 */
export type GraphResolution = 'resolved' | 'not-running' | 'missing' | 'rejected' | 'conflict'

/** One declared edge of a service. */
export interface GraphDependency {
  /** The local name in `dependsOn`. */
  readonly name: string
  /** The key names of the edge. A `firstAvailable` edge has its list. */
  readonly keys: readonly string[]
  readonly optional: boolean
  readonly fallback: boolean
  /** `true` when the edge has a resolution condition from `where`. */
  readonly conditional: boolean
  readonly resolution: GraphResolution
  /** The provider that the edge selects now. A `missing` edge has none. */
  readonly provider?: GraphService
}

/**
 * A proposed change for `impact`.
 *
 * - `withdraw`: the service of `key` is withdrawn.
 * - `replace`: the service of `key` gets a new instance.
 * - `dispose`: `container` and its descendants are disposed.
 */
export type ImpactChange
  = | { readonly kind: 'withdraw', readonly key: KeyReference }
    | { readonly kind: 'replace', readonly key: KeyReference }
    | { readonly kind: 'dispose', readonly container: Container }

/** The services that a proposed change affects. Each list has only services that have an instance now. */
export interface ImpactResult {
  /** The services that stop: the withdrawn services, and the dependents that lose a required dependency. */
  readonly stopped: readonly GraphService[]
  /** The dependents that rebuild, because a dependency changes and they have no `dependency-change` handler. */
  readonly rebuilt: readonly GraphService[]
  /** The dependents that get a `dependency-change` call. Their handler decides what happens. */
  readonly notified: readonly GraphService[]
}

/**
 * The graph queries of a container. They are pure reads and never change state.
 *
 * The queries cover the container and its descendants. A key resolves as for a consumer in the container: from the container, then from its ancestors.
 */
export interface Graph {
  /** All services and invocations, with the declared services of open transactions. */
  readonly services: () => readonly GraphService[]
  /** The declared edges of the service of `key`. */
  readonly dependencies: (key: KeyReference) => readonly GraphDependency[]
  /** The services whose edges select the service of `key` now. */
  readonly dependents: (key: KeyReference) => readonly GraphService[]
  /**
   * The topological order: each provider comes before its dependents.
   * With `keys`, the order has only those services and their transitive dependencies. The members of one cycle come together, in registration order.
   */
  readonly order: (keys?: readonly KeyReference[]) => readonly GraphService[]
  /** Each dependency cycle, as a list of services. */
  readonly cycles: () => readonly (readonly GraphService[])[]
  /** The services that a proposed change stops, rebuilds, or notifies. It runs on a copy of the graph. */
  readonly impact: (change: ImpactChange) => ImpactResult
  /** Why the service of `key` is not `running`: missing, conflicting, rejected, failed, or unavailable dependencies. */
  readonly explain: (key: KeyReference) => ServiceExplanation | undefined
}
