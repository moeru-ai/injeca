import type { DecisionKind } from '../../primitives/decision'
import type { OwnerRecord, ServiceMetadata, ServicePhase } from '../../types'
import type { BuildFunction, ContainerNode, DependencyEdge, InstanceNode, Policy, RegistrationNode, Resolution, ServiceKind, ServiceNode, SwapState, TransactionNode } from '../graph'

import { computed, effect, signal } from 'alien-signals'

import { createDeferred } from '../../helpers/deferred'
import { batch, untracked, withOwner } from '../../helpers/signals'
import { withoutUndefined } from '../../helpers/without-undefined'
import { emitRecord } from '../observers'
import { createRivals } from '../resolvers/exclusive'
import { resolveFallback } from '../resolvers/fallback'
import { resolvePlain } from '../resolvers/plain'
import { requiredWithdrawn } from '../resolvers/resolvers'
import { createEffectiveStatus, reportStatus } from '../status'

export interface PhaseDetails {
  readonly reason?: string
  readonly decision?: DecisionKind
}

/** Writes the phase and sends the change to the observe stream. */
export function setPhase(service: ServiceNode, to: ServicePhase, details: PhaseDetails = {}): void {
  const from = service.signals.phase()
  if (from === to)
    return

  batch(() => {
    service.signals.phase(to)
    if (service.kind === 'resolver')
      return

    emitRecord(service.container, {
      type: 'phase',
      key: service.name,
      owner: service.container.owner,
      instanceId: service.signals.instance()?.id,
      from,
      to,
      ...withoutUndefined({ reason: details.reason, decision: details.decision }),
    })
  })
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  if (a.kind !== b.kind)
    return false

  switch (a.kind) {
    case 'missing':
      return true
    case 'not-running':
    case 'rejected':
      return 'provider' in b && a.provider === b.provider
    case 'conflict':
      return b.kind === 'conflict' && a.provider === b.provider && a.rivals === b.rivals
    case 'resolved':
      return b.kind === 'resolved' && a.provider === b.provider && a.instance === b.instance
  }
}

/** Creates the resolution of one declared edge. It keeps the previous value when nothing changed. */
function resolveEdge(consumer: ServiceNode, edge: DependencyEdge): () => Resolution {
  return computed<Resolution>((previous) => {
    const next = edge.fallback ? resolveFallback(consumer, edge) : resolvePlain(consumer, edge)
    return previous && sameResolution(previous, next) ? previous : next
  })
}

export interface CreateServiceInput {
  readonly container: ContainerNode
  readonly kind: ServiceKind
  readonly name: string
  readonly edges: readonly DependencyEdge[]
  readonly build: BuildFunction
  readonly metadata?: ServiceMetadata
  /** The retry and timeout options of the registration. An invocation has none. */
  readonly policy?: Policy
  readonly exclusive?: boolean
  readonly perConsumer?: boolean
  readonly template?: ServiceNode
  readonly consumer?: OwnerRecord
  readonly transaction?: TransactionNode
  readonly registration?: RegistrationNode
  /** Set for a new service that replaces another service after it completes `start`. */
  readonly swap?: SwapState
  /** The first phase. It defaults to `pending`. A transaction starts its services in `declared`. */
  readonly phase?: ServicePhase
}

const emptyMetadata = Object.freeze({})
const emptyPolicy: Policy = Object.freeze({})

/**
 * Creates a service with its signals, its derived values, and its effects.
 *
 * The main effect reads the derived values of the service and only marks the service dirty.
 * The status effect sends each change of the effective status to the observe stream.
 */
export function createService(input: CreateServiceInput): ServiceNode {
  const { container } = input
  const { runtime } = container
  const present = signal(true)
  const phase = signal<ServicePhase>(input.phase ?? 'pending')
  const instance = signal<InstanceNode | undefined>(undefined)
  // A resolver always converges. It exists only while its `resolve` call waits.
  const demanded = signal(input.kind === 'resolver')
  const subscribers = signal<ReadonlySet<object>>(new Set())
  const resolutions = new Map<string, () => Resolution>()

  const effective = createEffectiveStatus({ phase, instance, edges: input.edges, resolutions })
  // The conflict reads the service, so it is created after the service object.
  let rivals: () => readonly ServiceNode[] = () => []

  const service: ServiceNode = {
    seq: runtime.nextSeq(),
    kind: input.kind,
    name: input.name,
    container,
    edges: input.edges,
    build: input.build,
    metadata: input.metadata ?? emptyMetadata,
    policy: input.policy ?? emptyPolicy,
    exclusive: input.exclusive ?? false,
    perConsumer: input.perConsumer ?? false,
    template: input.template,
    consumer: input.consumer,
    registration: input.registration,
    swap: input.swap,
    replacedBy: undefined,
    transaction: input.transaction,
    revision: 0,
    signals: {
      present,
      phase,
      instance,
      demanded,
      subscribers,
      // Only a service with a key can be demanded. An invocation waits for `start()`.
      active: computed(() => container.signals.started() || (input.kind !== 'invocation' && (demanded() || subscribers().size > 0))),
      serving: computed(() => present() && phase() === 'running'),
      resolutions,
      effective,
      rivals: () => rivals(),
      consumers: signal<ReadonlyMap<ContainerNode, ServiceNode>>(new Map()),
      targetLost: computed(() => !present() || !service.signals.active() || service.signals.rivals().length > 0 || requiredWithdrawn(service)),
    },
    busy: false,
    stopIntent: {},
    parkedEpoch: undefined,
    failure: undefined,
    demanders: new Set(),
    teardownErrors: [],
    withdrawal: createDeferred<readonly unknown[]>(),
    reportedStatus: undefined,
    disposeEffects: () => {},
  }

  for (const edge of input.edges)
    resolutions.set(edge.name, resolveEdge(service, edge))
  rivals = createRivals(service)

  const stopMain = withOwner(container.reactiveOwner, () => effect(() => {
    present()
    phase()
    service.signals.active()
    service.signals.rivals()
    instance()?.signals.holders()
    // A new service that waits to replace another one follows the old service.
    service.swap?.target.signals.present()
    for (const resolution of resolutions.values()) {
      const current = resolution()
      // A provider that is not running yet can still fail. A pending `resolve` call needs to see that.
      if (current.kind === 'not-running')
        current.provider.signals.phase()
      // A pending service waits for an available provider. A running one handles status changes.
      if (current.kind === 'resolved')
        current.provider.signals.effective()
    }

    runtime.reconciler.markDirty(service)
  }))

  const stopStatus = input.kind === 'resolver'
    ? () => {}
    : withOwner(container.reactiveOwner, () => effect(() => {
        const status = effective()
        // The report reads the instance. It must not track it.
        untracked(() => reportStatus(service, status))
      }))

  service.disposeEffects = () => {
    stopMain()
    stopStatus()
  }

  return service
}
