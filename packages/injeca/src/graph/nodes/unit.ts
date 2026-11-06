import type { DecisionKind } from '../../primitives/decision'
import type { OwnerRecord, UnitMetadata, UnitPhase } from '../../types'
import type { BuildFunction, ContainerNode, DependencyEdge, InstanceNode, Policy, RegistrationNode, Resolution, SwapState, TransactionNode, UnitKind, UnitNode } from '../graph'

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
export function setPhase(unit: UnitNode, to: UnitPhase, details: PhaseDetails = {}): void {
  const from = unit.signals.phase()
  if (from === to)
    return

  batch(() => {
    unit.signals.phase(to)
    if (unit.kind === 'resolver')
      return

    emitRecord(unit.container, {
      type: 'phase',
      key: unit.name,
      owner: unit.container.owner,
      instanceId: unit.signals.instance()?.id,
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
function resolveEdge(consumer: UnitNode, edge: DependencyEdge): () => Resolution {
  return computed<Resolution>((previous) => {
    const next = edge.fallback ? resolveFallback(consumer, edge) : resolvePlain(consumer, edge)
    return previous && sameResolution(previous, next) ? previous : next
  })
}

export interface CreateUnitInput {
  readonly container: ContainerNode
  readonly kind: UnitKind
  readonly name: string
  readonly edges: readonly DependencyEdge[]
  readonly build: BuildFunction
  readonly metadata?: UnitMetadata
  /** The retry and timeout options of the registration. An invocation has none. */
  readonly policy?: Policy
  readonly exclusive?: boolean
  /** `'parent'` for a registration that is visible to the parent. A consumer unit of a per-container registration is always `'local'`. */
  readonly visibility?: 'local' | 'parent'
  readonly instances?: 'shared' | 'per-container'
  readonly template?: UnitNode
  readonly consumer?: OwnerRecord
  readonly transaction?: TransactionNode
  readonly registration?: RegistrationNode
  /** Set for a new unit that replaces another unit after it completes `start`. */
  readonly swap?: SwapState
  /** The first phase. It defaults to `pending`. A transaction starts its units in `declared`. */
  readonly phase?: UnitPhase
  /** The place in registration order. A rebuild successor keeps the place of the unit that it replaces. */
  readonly seq?: number
}

const emptyMetadata = Object.freeze({})
const emptyPolicy: Policy = Object.freeze({})

/**
 * Creates a unit with its signals, its derived values, and its effects.
 *
 * The main effect reads the derived values of the unit and only marks the unit dirty.
 * The status effect sends each change of the effective status to the observe stream.
 */
export function createUnit(input: CreateUnitInput): UnitNode {
  const { container } = input
  const { runtime } = container
  const present = signal(true)
  const phase = signal<UnitPhase>(input.phase ?? 'pending')
  const instance = signal<InstanceNode | undefined>(undefined)
  // A resolver always converges. It exists only while its `resolve` call waits.
  const demanded = signal(input.kind === 'resolver')
  const subscribers = signal<ReadonlySet<object>>(new Set())
  const resolutions = new Map<string, () => Resolution>()

  const effective = createEffectiveStatus({ phase, instance, edges: input.edges, resolutions })
  // The conflict reads the unit, so it is created after the unit object.
  let rivals: () => readonly UnitNode[] = () => []

  const unit: UnitNode = {
    seq: input.seq ?? runtime.nextSeq(),
    kind: input.kind,
    name: input.name,
    container,
    scope: input.template?.container ?? container,
    edges: input.edges,
    build: input.build,
    metadata: input.metadata ?? emptyMetadata,
    policy: input.policy ?? emptyPolicy,
    exclusive: input.exclusive ?? false,
    visibility: input.template === undefined ? input.visibility ?? 'local' : 'local',
    instances: input.instances ?? 'shared',
    template: input.template,
    consumer: input.consumer,
    registration: input.registration,
    swap: input.swap,
    replacedBy: undefined,
    successor: undefined,
    transaction: input.transaction,
    revision: 0,
    signals: {
      present,
      phase,
      instance,
      demanded,
      subscribers,
      // Only a unit with a key can be demanded. An invocation waits for `start()`.
      active: computed(() => container.signals.started() || (input.kind !== 'invocation' && (demanded() || subscribers().size > 0))),
      serving: computed(() => present() && phase() === 'running'),
      resolutions,
      effective,
      rivals: () => rivals(),
      consumers: signal<ReadonlyMap<ContainerNode, UnitNode>>(new Map()),
      targetLost: computed(() => !present() || !unit.signals.active() || unit.signals.rivals().length > 0 || requiredWithdrawn(unit)),
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
    resolutions.set(edge.name, resolveEdge(unit, edge))
  rivals = createRivals(unit)

  const stopMain = withOwner(container.reactiveOwner, () => effect(() => {
    present()
    phase()
    unit.signals.active()
    unit.signals.rivals()
    instance()?.signals.holders()
    // A new unit that waits to replace another one follows the old unit.
    unit.swap?.target.signals.present()
    for (const resolution of resolutions.values()) {
      const current = resolution()
      // A provider that is not running yet can still fail. A pending `resolve` call needs to see that.
      if (current.kind === 'not-running')
        current.provider.signals.phase()
      // A pending unit waits for an available provider. A running one handles status changes.
      if (current.kind === 'resolved')
        current.provider.signals.effective()
    }

    runtime.reconciler.markDirty(unit)
  }))

  const stopStatus = input.kind === 'resolver'
    ? () => {}
    : withOwner(container.reactiveOwner, () => effect(() => {
        const status = effective()
        // The report reads the instance. It must not track it.
        untracked(() => reportStatus(unit, status))
      }))

  unit.disposeEffects = () => {
    stopMain()
    stopStatus()
  }

  return unit
}
