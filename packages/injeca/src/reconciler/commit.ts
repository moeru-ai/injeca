import type { DependencyEdge, InstanceNode, ServiceNode, TransactionNode } from '../graph/graph'
import type { SnapshotEntry } from './snapshot'

import { releaseReservations } from '../graph/nodes'
import { acceptsCandidate } from '../graph/resolvers/condition'
import { inConflict } from '../graph/resolvers/exclusive'
import { resolveKey } from '../graph/resolvers/plain'
import { requiredChanged } from '../graph/resolvers/resolvers'
import { prepareInstance, runBuild } from './build'
import { runStart } from './start'
import { finalize, teardown } from './stop'

/** The members of a transaction by key name, in the order of their registration. */
export type TransactionMembers = ReadonlyMap<string, ServiceNode>

/**
 * Orders the members so that each member comes after the members that it depends on.
 * Members in a cycle come last, in registration order. They cannot build in the transaction.
 */
export function orderMembers(members: TransactionMembers): ServiceNode[] {
  const order: ServiceNode[] = []
  const placed = new Set<ServiceNode>()
  const remaining = [...members.values()]

  let progress = true
  while (progress) {
    progress = false
    for (const member of remaining) {
      if (placed.has(member))
        continue

      const ready = member.edges.every(edge => edge.candidates.every((keyName) => {
        const provider = members.get(keyName)
        return !provider || provider === member || placed.has(provider)
      }))
      if (ready) {
        placed.add(member)
        order.push(member)
        progress = true
      }
    }
  }

  return [...order, ...remaining.filter(member => !placed.has(member))]
}

function memberEntry(member: ServiceNode, built: ReadonlyMap<ServiceNode, InstanceNode>): SnapshotEntry | undefined {
  const instance = built.get(member)
  if (!instance)
    return undefined

  return {
    state: Object.freeze({ provider: member.name, instanceId: instance.id, status: instance.signals.own().status }),
    instance,
  }
}

/** Resolves one key inside a transaction: a built member first, then the published providers. */
function resolveInTransaction(service: ServiceNode, keyName: string, edge: DependencyEdge, members: TransactionMembers, built: ReadonlyMap<ServiceNode, InstanceNode>): SnapshotEntry | undefined {
  const member = members.get(keyName)
  if (member && member !== service) {
    if (inConflict(member) || !acceptsCandidate(service, edge, keyName, member))
      return undefined
    return memberEntry(member, built)
  }

  const resolution = resolveKey(service, keyName, edge)
  if (resolution.kind !== 'resolved')
    return undefined

  return {
    state: Object.freeze({ provider: resolution.provider.name, instanceId: resolution.instance.id, status: resolution.provider.signals.effective()?.status ?? 'unavailable' }),
    instance: resolution.instance,
  }
}

/** The snapshot of a member for its build in the transaction. It is `undefined` when a required dependency is not available. */
function transactionSnapshot(service: ServiceNode, members: TransactionMembers, built: ReadonlyMap<ServiceNode, InstanceNode>): Map<string, SnapshotEntry | undefined> | undefined {
  const snapshot = new Map<string, SnapshotEntry | undefined>()
  for (const edge of service.edges) {
    const entries = edge.candidates.map(keyName => resolveInTransaction(service, keyName, edge, members, built))
    const entry = entries.find(candidate => candidate !== undefined && candidate.state.status !== 'unavailable') ?? entries.find(candidate => candidate !== undefined)
    if (!edge.optional && (!entry || entry.state.status === 'unavailable'))
      return undefined

    snapshot.set(edge.name, entry)
  }

  return snapshot
}

export type BuildOutcome
  = | { readonly kind: 'built', readonly built: ReadonlyMap<ServiceNode, InstanceNode> }
    | { readonly kind: 'failed', readonly error: unknown, readonly built: ReadonlyMap<ServiceNode, InstanceNode> }
    | { readonly kind: 'aborted', readonly built: ReadonlyMap<ServiceNode, InstanceNode> }

/**
 * Builds the members of a transaction in `order`. Nothing is published, and no `start` hook runs.
 *
 * A member whose required dependencies are not available, that is not active, or whose key is in conflict, does not build. It goes to `pending` at the publish.
 * The first failed build ends the loop. An abort ends it after the build in progress settles.
 */
export async function buildMembers(transaction: TransactionNode, order: readonly ServiceNode[], members: TransactionMembers): Promise<BuildOutcome> {
  const built = new Map<ServiceNode, InstanceNode>()
  for (const member of order) {
    if (transaction.state === 'aborted')
      return { kind: 'aborted', built }
    if (member.perConsumer || !member.signals.active() || inConflict(member))
      continue

    const snapshot = transactionSnapshot(member, members, built)
    if (!snapshot)
      continue

    const instance = prepareInstance(member, snapshot)
    transaction.controllers.add(instance.controller)
    const result = await runBuild(member, instance)
    transaction.controllers.delete(instance.controller)
    instance.building = false
    built.set(member, instance)

    if (!result.ok)
      return { kind: 'failed', error: result.error, built }
    instance.value = result.value
  }

  return transaction.state === 'aborted' ? { kind: 'aborted', built } : { kind: 'built', built }
}

/**
 * Removes all members after a failed build or an abort. A built instance runs its effect disposers. No `stop` hook runs, because no `start` hook ran.
 * Resolves when each member is `withdrawn`.
 */
export async function rollbackMembers(members: TransactionMembers, built: ReadonlyMap<ServiceNode, InstanceNode>): Promise<void> {
  for (const member of members.values())
    member.signals.present(false)

  await Promise.all([...members.values()].map((member) => {
    const instance = built.get(member)
    if (instance)
      return teardown(member, instance, false)

    finalize(member)
    return undefined
  }))
}

/**
 * Runs the `start` hooks of the built members after the publish, in dependency order.
 * A member whose target changed, or whose dependency did not reach `running`, is discarded without its `stop` hooks. It builds again later.
 */
export async function startMembers(order: readonly ServiceNode[], built: ReadonlyMap<ServiceNode, InstanceNode>): Promise<void> {
  for (const member of order) {
    const instance = built.get(member)
    if (!instance)
      continue

    if (member.signals.targetLost() || requiredChanged(member, instance))
      await teardown(member, instance, false, 'stopping')
    else
      await runStart(member, instance)
  }
}

/**
 * Aborts a transaction. Before the commit, it drops the transaction. During the commit, it aborts the builds in progress, and the commit rolls back.
 * Resolves when the transaction ended.
 */
export function abortTransaction(transaction: TransactionNode, error: unknown): Promise<void> {
  if (transaction.state === 'done' || transaction.state === 'aborted')
    return transaction.settled ?? Promise.resolve()

  const committing = transaction.state === 'committing'
  transaction.state = 'aborted'
  transaction.abortError = error
  for (const controller of transaction.controllers)
    controller.abort(error)
  if (!committing) {
    transaction.container.transactions.delete(transaction)
    transaction.settled = Promise.resolve()
    releaseReservations(transaction)
  }

  return transaction.settled ?? Promise.resolve()
}
