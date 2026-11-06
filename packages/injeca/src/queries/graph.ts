import type { ContainerNode, DependencyEdge, TransactionEntry, UnitNode } from '../graph/graph'
import type { Container, Graph, GraphDependency, GraphResolution, GraphUnit, ImpactChange, ImpactResult, KeyReference, UnitExplanation } from '../types'
import type { ProposedChange } from './impact'

import { InvalidArgumentError } from '../diagnostics/errors'
import { explainUnit } from '../diagnostics/explain'
import { nodeOf, subtreeOf } from '../graph/nodes'
import { findProvider, resolutionOf, selectProvider } from '../graph/resolvers/resolvers'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'
import { normalizeName } from '../primitives/keys'
import { computeImpact, disposedUnits, withdrawnUnits } from './impact'

const emptyMetadata = Object.freeze({})

function readKey(key: unknown, action: string): string {
  let name: unknown
  try {
    name = normalizeName(key as string)
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the key of ${action}.`, { cause: error })
  }
  if (typeof name !== 'string' || name.length === 0)
    throw new InvalidArgumentError(`The key of ${action} must be a name or a key.`)

  return name
}

function entryOf(unit: UnitNode): GraphUnit {
  const status = unit.signals.effective()
  return Object.freeze({
    key: unit.name,
    kind: unit.kind === 'invocation' ? 'invocation' : 'unit',
    owner: unit.container.owner,
    phase: unit.signals.phase(),
    ...withoutUndefined({ status: status?.status, instanceId: unit.signals.instance()?.id, consumer: unit.consumer }),
    metadata: unit.metadata,
    exclusive: unit.exclusive,
    instances: unit.instances,
    visibility: unit.visibility,
  })
}

function declaredEntryOf(container: ContainerNode, entry: TransactionEntry): GraphUnit {
  return Object.freeze({
    key: entry.name,
    kind: 'unit',
    owner: container.owner,
    phase: 'declared',
    metadata: entry.definition?.metadata ?? emptyMetadata,
    exclusive: entry.exclusive,
    instances: entry.definition?.instances ?? 'shared',
    visibility: entry.visibility,
  })
}

/** The units and invocations of the scope that are not `withdrawn`, in registration order. */
function unitsOf(scope: ContainerNode): UnitNode[] {
  return subtreeOf(scope)
    .flatMap(container => [...container.units])
    .filter(unit => unit.kind !== 'resolver' && unit.signals.phase() !== 'withdrawn')
    .sort((a, b) => a.seq - b.seq)
}

/** The keys that open transactions declared and did not publish yet. */
function declaredOf(scope: ContainerNode): { readonly container: ContainerNode, readonly entry: TransactionEntry }[] {
  return subtreeOf(scope).flatMap(container => [...container.transactions]
    .filter(transaction => transaction.state === 'open')
    .flatMap(transaction => [...transaction.entries.values()].map(entry => ({ container, entry }))))
}

/** Finds the unit of `name`: the provider that a consumer in `scope` sees, then the first unit of that name in the scope. */
function lookup(scope: ContainerNode, name: string): UnitNode | undefined {
  return findProvider(scope, name) ?? unitsOf(scope).find(unit => unit.name === name)
}

/** The providers that the edges of `unit` select now, served or not. */
function targetsOf(unit: UnitNode): UnitNode[] {
  return unit.edges.flatMap(edge => edge.candidates.flatMap((keyName) => {
    const provider = findProvider(unit.scope, keyName, unit)
    return provider ? [provider] : []
  }))
}

function resolutionKind(unit: UnitNode, edge: DependencyEdge): { readonly kind: GraphResolution, readonly provider?: UnitNode } {
  const resolution = resolutionOf(unit, edge)
  return resolution.kind === 'missing' ? { kind: 'missing' } : { kind: resolution.kind, provider: resolution.provider }
}

function dependencyOf(edge: DependencyEdge, resolution: { readonly kind: GraphResolution, readonly provider?: UnitNode }): GraphDependency {
  return Object.freeze({
    name: edge.name,
    keys: edge.candidates,
    optional: edge.optional,
    fallback: edge.fallback,
    conditional: edge.condition !== undefined || edge.candidateConditions !== undefined,
    resolution: resolution.kind,
    ...withoutUndefined({ provider: resolution.provider && entryOf(resolution.provider) }),
  })
}

/** The resolution of a declared edge, which has no computed resolution yet. */
function declaredResolution(container: ContainerNode, edge: DependencyEdge): { readonly kind: GraphResolution, readonly provider?: UnitNode } {
  for (const keyName of edge.candidates) {
    const selection = selectProvider(container, keyName)
    if (!selection)
      continue
    const provider = selection.provider ?? selection.registration
    return { kind: provider.signals.serving() ? 'resolved' : 'not-running', provider }
  }

  return { kind: 'missing' }
}

/**
 * Orders `units` so that each provider comes before its dependents. It is Tarjan's algorithm: each cycle comes out as one group.
 * Returns the groups in order.
 */
function components(units: readonly UnitNode[]): UnitNode[][] {
  const inScope = new Set(units)
  const index = new Map<UnitNode, number>()
  const low = new Map<UnitNode, number>()
  const stack: UnitNode[] = []
  const onStack = new Set<UnitNode>()
  const groups: UnitNode[][] = []
  let counter = 0

  const visit = (unit: UnitNode): void => {
    index.set(unit, counter)
    low.set(unit, counter)
    counter++
    stack.push(unit)
    onStack.add(unit)

    for (const target of targetsOf(unit)) {
      if (!inScope.has(target))
        continue
      if (!index.has(target)) {
        visit(target)
        low.set(unit, Math.min(low.get(unit)!, low.get(target)!))
      }
      else if (onStack.has(target)) {
        low.set(unit, Math.min(low.get(unit)!, index.get(target)!))
      }
    }

    if (low.get(unit) === index.get(unit)) {
      const group: UnitNode[] = []
      let member: UnitNode | undefined
      do {
        member = stack.pop()!
        onStack.delete(member)
        group.push(member)
      } while (member !== unit)
      groups.push(group.sort((a, b) => a.seq - b.seq))
    }
  }

  for (const unit of units) {
    if (!index.has(unit))
      visit(unit)
  }

  return groups
}

/** The units of `roots` and their transitive dependencies. */
function closure(roots: readonly UnitNode[]): UnitNode[] {
  const seen = new Set<UnitNode>()
  const queue = [...roots]
  while (queue.length > 0) {
    const unit = queue.shift()!
    if (seen.has(unit))
      continue

    seen.add(unit)
    queue.push(...targetsOf(unit))
  }

  return [...seen].sort((a, b) => a.seq - b.seq)
}

function sorted(units: ReadonlySet<UnitNode>): readonly GraphUnit[] {
  return Object.freeze([...units].sort((a, b) => a.seq - b.seq).map(entryOf))
}

function proposedChange(scope: ContainerNode, change: ImpactChange): ProposedChange {
  let kind: unknown
  let key: unknown
  let container: unknown
  try {
    kind = change.kind
    key = 'key' in change ? change.key : undefined
    container = 'container' in change ? change.container : undefined
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the impact change.', { cause: error })
  }

  switch (kind) {
    case 'withdraw':
    case 'replace': {
      const unit = lookup(scope, readKey(key, 'impact'))
      if (!unit)
        return { removed: new Set(), renewed: new Set() }
      const registration = unit.template ?? unit
      return kind === 'withdraw'
        ? { removed: withdrawnUnits(registration), renewed: new Set() }
        : { removed: new Set(), renewed: withdrawnUnits(registration) }
    }
    case 'dispose':
      return { removed: disposedUnits(nodeOf(container as Container)), renewed: new Set() }
    default:
      throw new InvalidArgumentError(`The impact change kind must be 'withdraw', 'replace', or 'dispose'. Got ${String(kind)}.`)
  }
}

/**
 * Returns the graph queries of `container`. They cover the container and its descendants. Each query is a pure read.
 *
 * A key resolves as for a consumer in the container: from the container and the parent-visible units of its children, then from each ancestor and the parent-visible units of its children.
 * A key that only a descendant has resolves to the first such unit.
 */
export function graph(container: Container): Graph {
  const scope = nodeOf(container)

  return Object.freeze({
    units: () => untracked(() => Object.freeze([
      ...unitsOf(scope).map(entryOf),
      ...declaredOf(scope).map(({ container: owner, entry }) => declaredEntryOf(owner, entry)),
    ])),

    dependencies: (key: KeyReference) => untracked(() => {
      const name = readKey(key, 'dependencies')
      const unit = lookup(scope, name)
      if (unit)
        return Object.freeze(unit.edges.map(edge => dependencyOf(edge, resolutionKind(unit, edge))))

      const declared = declaredOf(scope).find(({ entry }) => entry.name === name)
      const edges = declared?.entry.definition?.edges ?? declared?.entry.declared ?? []
      return Object.freeze(edges.map(edge => dependencyOf(edge, declaredResolution(declared!.container, edge))))
    }),

    dependents: (key: KeyReference) => untracked(() => {
      const target = lookup(scope, readKey(key, 'dependents'))
      if (!target)
        return Object.freeze([])

      const registration = target.template ?? target
      return Object.freeze(unitsOf(scope)
        .filter(unit => unit.edges.some((edge) => {
          const resolution = resolutionOf(unit, edge)
          return resolution.kind !== 'missing' && (resolution.provider === target || (resolution.provider.template ?? resolution.provider) === registration)
        }))
        .map(entryOf))
    }),

    order: (keys?: readonly KeyReference[]) => untracked(() => {
      const units = keys === undefined
        ? unitsOf(scope)
        : closure(keys.flatMap((key) => {
            const unit = lookup(scope, readKey(key, 'order'))
            return unit ? [unit] : []
          }))

      return Object.freeze(components(units).flat().map(entryOf))
    }),

    cycles: () => untracked(() => Object.freeze(components(unitsOf(scope))
      .filter(group => group.length > 1)
      .map(group => Object.freeze(group.map(entryOf))))),

    impact: (change: ImpactChange): ImpactResult => untracked(() => {
      const result = computeImpact(scope, proposedChange(scope, change))
      return Object.freeze({ stopped: sorted(result.stopped), rebuilt: sorted(result.rebuilt), notified: sorted(result.notified) })
    }),

    explain: (key: KeyReference): UnitExplanation => untracked(() => {
      const name = readKey(key, 'explain')
      const unit = lookup(scope, name)
      if (unit)
        return explainUnit(unit)

      const declared = declaredOf(scope).find(({ entry }) => entry.name === name)
      if (declared)
        return Object.freeze({ name, kind: 'unit', owner: declared.container.owner, phase: 'declared', blockers: Object.freeze([]) })

      // No unit exists for the key. A consumer in the container waits for a provider.
      return Object.freeze({ name, kind: 'unit', owner: scope.owner, phase: undefined, blockers: Object.freeze([Object.freeze({ kind: 'missing-provider', dependency: name, key: name })]) })
    }),
  })
}
