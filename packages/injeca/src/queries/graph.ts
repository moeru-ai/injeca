import type { ContainerNode, DependencyEdge, ServiceNode, TransactionEntry } from '../graph/graph'
import type { Container, Graph, GraphDependency, GraphResolution, GraphService, ImpactChange, ImpactResult, KeyReference, ServiceExplanation } from '../types'
import type { ProposedChange } from './impact'

import { InvalidArgumentError } from '../diagnostics/errors'
import { explainService } from '../diagnostics/explain'
import { nodeOf, subtreeOf } from '../graph/nodes'
import { findProvider, resolutionOf, selectProvider } from '../graph/resolvers/resolvers'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'
import { normalizeName } from '../primitives/keys'
import { computeImpact, disposedServices, withdrawnServices } from './impact'

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

function entryOf(service: ServiceNode): GraphService {
  const status = service.signals.effective()
  return Object.freeze({
    key: service.name,
    kind: service.kind === 'invocation' ? 'invocation' : 'service',
    owner: service.container.owner,
    phase: service.signals.phase(),
    ...withoutUndefined({ status: status?.status, instanceId: service.signals.instance()?.id, consumer: service.consumer }),
    metadata: service.metadata,
    exclusive: service.exclusive,
    perConsumer: service.perConsumer,
    exported: service.exported,
  })
}

function declaredEntryOf(container: ContainerNode, entry: TransactionEntry): GraphService {
  return Object.freeze({
    key: entry.name,
    kind: 'service',
    owner: container.owner,
    phase: 'declared',
    metadata: entry.definition?.metadata ?? emptyMetadata,
    exclusive: entry.exclusive,
    perConsumer: entry.definition?.perConsumer ?? false,
    exported: entry.exported,
  })
}

/** The services and invocations of the scope that are not `withdrawn`, in registration order. */
function servicesOf(scope: ContainerNode): ServiceNode[] {
  return subtreeOf(scope)
    .flatMap(container => [...container.services])
    .filter(service => service.kind !== 'resolver' && service.signals.phase() !== 'withdrawn')
    .sort((a, b) => a.seq - b.seq)
}

/** The keys that open transactions declared and did not publish yet. */
function declaredOf(scope: ContainerNode): { readonly container: ContainerNode, readonly entry: TransactionEntry }[] {
  return subtreeOf(scope).flatMap(container => [...container.transactions]
    .filter(transaction => transaction.state === 'open')
    .flatMap(transaction => [...transaction.entries.values()].map(entry => ({ container, entry }))))
}

/** Finds the service of `name`: the provider that a consumer in `scope` sees, then the first service of that name in the scope. */
function lookup(scope: ContainerNode, name: string): ServiceNode | undefined {
  return findProvider(scope, name) ?? servicesOf(scope).find(service => service.name === name)
}

/** The providers that the edges of `service` select now, served or not. */
function targetsOf(service: ServiceNode): ServiceNode[] {
  return service.edges.flatMap(edge => edge.candidates.flatMap((keyName) => {
    const provider = findProvider(service.scope, keyName, service)
    return provider ? [provider] : []
  }))
}

function resolutionKind(service: ServiceNode, edge: DependencyEdge): { readonly kind: GraphResolution, readonly provider?: ServiceNode } {
  const resolution = resolutionOf(service, edge)
  return resolution.kind === 'missing' ? { kind: 'missing' } : { kind: resolution.kind, provider: resolution.provider }
}

function dependencyOf(edge: DependencyEdge, resolution: { readonly kind: GraphResolution, readonly provider?: ServiceNode }): GraphDependency {
  return Object.freeze({
    name: edge.name,
    keys: edge.candidates,
    optional: edge.optional,
    fallback: edge.fallback,
    conditional: edge.condition !== undefined,
    resolution: resolution.kind,
    ...withoutUndefined({ provider: resolution.provider && entryOf(resolution.provider) }),
  })
}

/** The resolution of a declared edge, which has no computed resolution yet. */
function declaredResolution(container: ContainerNode, edge: DependencyEdge): { readonly kind: GraphResolution, readonly provider?: ServiceNode } {
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
 * Orders `services` so that each provider comes before its dependents. It is Tarjan's algorithm: each cycle comes out as one group.
 * Returns the groups in order.
 */
function components(services: readonly ServiceNode[]): ServiceNode[][] {
  const inScope = new Set(services)
  const index = new Map<ServiceNode, number>()
  const low = new Map<ServiceNode, number>()
  const stack: ServiceNode[] = []
  const onStack = new Set<ServiceNode>()
  const groups: ServiceNode[][] = []
  let counter = 0

  const visit = (service: ServiceNode): void => {
    index.set(service, counter)
    low.set(service, counter)
    counter++
    stack.push(service)
    onStack.add(service)

    for (const target of targetsOf(service)) {
      if (!inScope.has(target))
        continue
      if (!index.has(target)) {
        visit(target)
        low.set(service, Math.min(low.get(service)!, low.get(target)!))
      }
      else if (onStack.has(target)) {
        low.set(service, Math.min(low.get(service)!, index.get(target)!))
      }
    }

    if (low.get(service) === index.get(service)) {
      const group: ServiceNode[] = []
      let member: ServiceNode | undefined
      do {
        member = stack.pop()!
        onStack.delete(member)
        group.push(member)
      } while (member !== service)
      groups.push(group.sort((a, b) => a.seq - b.seq))
    }
  }

  for (const service of services) {
    if (!index.has(service))
      visit(service)
  }

  return groups
}

/** The services of `roots` and their transitive dependencies. */
function closure(roots: readonly ServiceNode[]): ServiceNode[] {
  const seen = new Set<ServiceNode>()
  const queue = [...roots]
  while (queue.length > 0) {
    const service = queue.shift()!
    if (seen.has(service))
      continue

    seen.add(service)
    queue.push(...targetsOf(service))
  }

  return [...seen].sort((a, b) => a.seq - b.seq)
}

function sorted(services: ReadonlySet<ServiceNode>): readonly GraphService[] {
  return Object.freeze([...services].sort((a, b) => a.seq - b.seq).map(entryOf))
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
      const service = lookup(scope, readKey(key, 'impact'))
      if (!service)
        return { removed: new Set(), renewed: new Set() }
      const registration = service.template ?? service
      return kind === 'withdraw'
        ? { removed: withdrawnServices(registration), renewed: new Set() }
        : { removed: new Set(), renewed: withdrawnServices(registration) }
    }
    case 'dispose':
      return { removed: disposedServices(nodeOf(container as Container)), renewed: new Set() }
    default:
      throw new InvalidArgumentError(`The impact change kind must be 'withdraw', 'replace', or 'dispose'. Got ${String(kind)}.`)
  }
}

/**
 * Returns the graph queries of `container`. They cover the container and its descendants. Each query is a pure read.
 *
 * A key resolves as for a consumer in the container: from the container and the exports of its children, then from each ancestor and the exports of its children.
 * A key that only a descendant has resolves to the first such service.
 */
export function graph(container: Container): Graph {
  const scope = nodeOf(container)

  return Object.freeze({
    services: () => untracked(() => Object.freeze([
      ...servicesOf(scope).map(entryOf),
      ...declaredOf(scope).map(({ container: owner, entry }) => declaredEntryOf(owner, entry)),
    ])),

    dependencies: (key: KeyReference) => untracked(() => {
      const name = readKey(key, 'dependencies')
      const service = lookup(scope, name)
      if (service)
        return Object.freeze(service.edges.map(edge => dependencyOf(edge, resolutionKind(service, edge))))

      const declared = declaredOf(scope).find(({ entry }) => entry.name === name)
      const edges = declared?.entry.definition?.edges ?? declared?.entry.declared ?? []
      return Object.freeze(edges.map(edge => dependencyOf(edge, declaredResolution(declared!.container, edge))))
    }),

    dependents: (key: KeyReference) => untracked(() => {
      const target = lookup(scope, readKey(key, 'dependents'))
      if (!target)
        return Object.freeze([])

      const registration = target.template ?? target
      return Object.freeze(servicesOf(scope)
        .filter(service => service.edges.some((edge) => {
          const resolution = resolutionOf(service, edge)
          return resolution.kind !== 'missing' && (resolution.provider === target || (resolution.provider.template ?? resolution.provider) === registration)
        }))
        .map(entryOf))
    }),

    order: (keys?: readonly KeyReference[]) => untracked(() => {
      const services = keys === undefined
        ? servicesOf(scope)
        : closure(keys.flatMap((key) => {
            const service = lookup(scope, readKey(key, 'order'))
            return service ? [service] : []
          }))

      return Object.freeze(components(services).flat().map(entryOf))
    }),

    cycles: () => untracked(() => Object.freeze(components(servicesOf(scope))
      .filter(group => group.length > 1)
      .map(group => Object.freeze(group.map(entryOf))))),

    impact: (change: ImpactChange): ImpactResult => untracked(() => {
      const result = computeImpact(scope, proposedChange(scope, change))
      return Object.freeze({ stopped: sorted(result.stopped), rebuilt: sorted(result.rebuilt), notified: sorted(result.notified) })
    }),

    explain: (key: KeyReference): ServiceExplanation => untracked(() => {
      const name = readKey(key, 'explain')
      const service = lookup(scope, name)
      if (service)
        return explainService(service)

      const declared = declaredOf(scope).find(({ entry }) => entry.name === name)
      if (declared)
        return Object.freeze({ name, kind: 'service', owner: declared.container.owner, phase: 'declared', blockers: Object.freeze([]) })

      // No service exists for the key. A consumer in the container waits for a provider.
      return Object.freeze({ name, kind: 'service', owner: scope.owner, phase: undefined, blockers: Object.freeze([Object.freeze({ kind: 'missing-provider', dependency: name, key: name })]) })
    }),
  })
}
