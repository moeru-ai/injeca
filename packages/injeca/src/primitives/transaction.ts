import type { ContainerNode, RegistrationNode, ServiceDefinition, ServiceNode, TransactionEntry, TransactionNode } from '../graph/graph'
import type { TransactionMembers } from '../reconciler/commit'
import type { Container, DeclareOptions, KeyReference, Registration, Transaction, TransactionProvide, TransactionReplace } from '../types'

import { DuplicateServiceError, InvalidArgumentError, ReplaceWhileStoppingError, StaleRegistrationError, TransactionIncompleteError } from '../diagnostics/errors'
import { assertActive, cancelPending, createRegistration, currentService, nodeOf, readDefinition, readEdges, releaseReservation, releaseReservations, reservedBy, reserveKey, setPhase, withdrawRegistration } from '../graph/nodes'
import { slotOf } from '../graph/resolvers/resolvers'
import { batch, untracked } from '../helpers/signals'
import { abortTransaction, buildMembers, orderMembers, rollbackMembers, startMembers } from '../reconciler/commit'
import { isExclusiveKey, normalizeName } from './keys'
import { assertNoDuplicate, publishRegistration, serviceOf } from './provide'
import { registrationApi, registrationOf, replaceRunning, replaceTemplate, takeOver } from './replace'

function readName(key: unknown, action: string): string {
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

function readDeclareOptions(name: string, options: DeclareOptions | undefined): { readonly dependsOn: unknown, readonly optional: boolean } {
  let dependsOn: unknown
  let optional: unknown
  try {
    dependsOn = options?.dependsOn
    optional = options?.optional
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the declare options of '${name}'.`, { cause: error })
  }
  if (optional !== undefined && typeof optional !== 'boolean')
    throw new InvalidArgumentError(`The optional option of '${name}' must be a boolean.`)

  return { dependsOn, optional: optional === true }
}

/** One member of a commit, with what its publish does. */
interface Member {
  readonly entry: TransactionEntry
  readonly service: ServiceNode
  /** The service that a `tx.replace` replaces. */
  readonly target?: ServiceNode
}

/** The service that a `tx.replace` names now. A stale registration, or a key without a registration, fails. */
function replaceTarget(container: ContainerNode, entry: TransactionEntry): ServiceNode {
  const target = entry.target ? currentService(entry.target) : slotOf(container, entry.name)()
  if (!target || !target.signals.present())
    throw new StaleRegistrationError(`The transaction replaces '${entry.name}', but the container has no current registration for it.`)
  if (target.signals.phase() === 'stopping')
    throw new ReplaceWhileStoppingError(`The transaction replaces '${entry.name}', but it is stopping.`)

  return target
}

/** Checks the entries and creates the services of a commit. The services are not published. */
function createMembers(transaction: TransactionNode): Member[] {
  const { container } = transaction
  assertActive(container, 'commit a transaction')

  const incomplete = [...transaction.entries.values()].filter(entry => !entry.definition && !entry.optional)
  if (incomplete.length > 0)
    throw new TransactionIncompleteError(`These declared services have no provide: ${incomplete.map(entry => `'${entry.name}'`).join(', ')}.`)

  const entries = [...transaction.entries.values()].filter(entry => entry.definition)
  const targets = new Map<TransactionEntry, ServiceNode>()
  for (const entry of entries) {
    if (entry.replace)
      targets.set(entry, replaceTarget(container, entry))
    else
      assertNoDuplicate(container, entry.name, transaction)
  }

  const members: Member[] = []
  batch(() => {
    for (const entry of entries) {
      const definition = entry.definition!
      const target = targets.get(entry)
      const extra = { phase: 'declared' as const, transaction }
      if (!target) {
        members.push({ entry, service: serviceOf(container, entry.name, definition, entry.exclusive, { ...extra, registration: entry.registration }) })
        continue
      }

      const registration = target.registration ?? createRegistration(container, entry.name, target.exclusive)
      const service = target.signals.phase() === 'running' && !target.perConsumer
        ? replaceRunning(registration, target, definition, extra).service
        : serviceOf(container, entry.name, { ...definition, perConsumer: target.perConsumer, exported: target.exported }, target.exclusive, { ...extra, registration })
      members.push({ entry, service, target })
    }
  })

  return members
}

/** Publishes the members in one batch. A built member goes to `starting`, the others to `pending`. The reservations end in the same batch. */
function publishMembers(transaction: TransactionNode, members: readonly Member[], built: ReadonlySet<ServiceNode>): void {
  batch(() => {
    releaseReservations(transaction)
    for (const { service, target } of members) {
      service.transaction = undefined
      const registration = service.registration
      if (target && registration && service.swap) {
        // The new service swaps in after it completes `start`.
        cancelPending(registration)
        registration.pending = service
      }
      else if (target && registration && target.perConsumer) {
        // The commit does not wait for the swap, as for a running service.
        void replaceTemplate(registration, target, service)
      }
      else if (target && registration) {
        takeOver(registration, target, service)
      }
      else {
        publishRegistration(service.container, service)
        if (registration)
          registration.current = service
      }

      if (service.signals.present())
        setPhase(service, built.has(service) ? 'starting' : 'pending', { reason: built.has(service) ? 'The transaction committed.' : 'The transaction committed. The service waits for its dependencies.' })
    }
  })
}

async function commit(transaction: TransactionNode): Promise<void> {
  const members = untracked(() => createMembers(transaction))
  const byName: TransactionMembers = new Map(members.map(member => [member.service.name, member.service]))
  const order = orderMembers(byName)

  const outcome = await buildMembers(transaction, order, byName)
  if (outcome.kind !== 'built') {
    await untracked(() => rollbackMembers(byName, outcome.built))
    throw outcome.kind === 'failed' ? outcome.error : transaction.abortError
  }

  untracked(() => publishMembers(transaction, members, new Set(outcome.built.keys())))
  transaction.state = 'done'
  transaction.container.transactions.delete(transaction)
  // The `start` hooks run after the publish. The commit does not wait for them.
  void startMembers(order, outcome.built)
}

function startCommit(transaction: TransactionNode): Promise<void> {
  if (transaction.state !== 'open')
    return Promise.reject(new InvalidArgumentError(`The transaction is ${transaction.state === 'aborted' ? 'aborted' : 'already committed'}.`))

  transaction.state = 'committing'
  const result = commit(transaction).catch((error: unknown) => {
    if (transaction.state !== 'done') {
      transaction.state = 'aborted'
      transaction.container.transactions.delete(transaction)
      untracked(() => releaseReservations(transaction))
    }
    throw error
  })
  transaction.settled = result.then(() => {}, () => {})

  return result
}

/** Throws `duplicate-service` when another open transaction of the container declares or provides `name`. */
function assertNotReserved(transaction: TransactionNode, name: string): void {
  if (reservedBy(transaction.container.transactions, name, transaction))
    throw new DuplicateServiceError(`Another open transaction of the container reserves '${name}'.`)
}

function assertOpen(transaction: TransactionNode, action: string): void {
  if (transaction.state !== 'open')
    throw new InvalidArgumentError(`Cannot ${action} after the transaction committed or aborted.`)
}

function entryOf(transaction: TransactionNode, name: string, exclusive: boolean): TransactionEntry {
  let entry = transaction.entries.get(name)
  if (!entry) {
    entry = { name, declared: undefined, optional: false, definition: undefined, replace: false, target: undefined, registration: undefined, exclusive, exported: false, reservation: undefined }
    transaction.entries.set(name, entry)
  }

  return entry
}

/**
 * Creates a transaction for `container`.
 *
 * `declare` reserves services. `provide` and `replace` add services. Nothing is visible to consumers before `commit()`.
 * `commit()` builds the services in dependency order and publishes them in one batch. Then the `start` hooks run.
 * A failed build publishes nothing. A disposal of the container during the transaction aborts it.
 */
export function transaction(container: Container): Transaction {
  const node = nodeOf(container)
  assertActive(node, 'create a transaction')

  const state: TransactionNode = {
    container: node,
    state: 'open',
    entries: new Map(),
    abortError: undefined,
    controllers: new Set(),
    settled: undefined,
  }
  node.transactions.add(state)

  const declare = (key: KeyReference, options?: DeclareOptions): void => {
    assertOpen(state, 'declare')
    const name = readName(key, 'declare')
    const { dependsOn, optional } = readDeclareOptions(name, options)
    assertNotReserved(state, name)
    const declared = readEdges(name, dependsOn)
    const entry = entryOf(state, name, false)
    entry.exclusive ||= isExclusiveKey(key)
    entry.declared = declared
    entry.optional = optional
    untracked(() => reserveKey(state, entry))
  }

  /**
   * The `withdraw()` of a registration from `tx.provide`. Before the commit, it removes the provide from the transaction and resolves `true`.
   * A declaration of the key stays, so the commit fails with `transaction-incomplete` unless the declaration is optional.
   * During the commit, it waits for the commit, then withdraws the published service.
   */
  const withdrawEntry = async (entry: TransactionEntry, registration: RegistrationNode): Promise<boolean> => {
    if (state.state === 'open') {
      if (entry.registration !== registration)
        return false

      entry.definition = undefined
      entry.registration = undefined
      entry.exported = false
      untracked(() => {
        if (!entry.declared) {
          state.entries.delete(entry.name)
          releaseReservation(entry)
        }
        else {
          // The declaration stays, in the resolution area of the container itself.
          reserveKey(state, entry)
        }
      })
      return true
    }
    if (state.state === 'committing')
      await state.settled

    return withdrawRegistration(registration)
  }

  const provide = ((key: KeyReference, option: unknown): Registration<string, unknown, undefined> => {
    assertOpen(state, 'provide')
    const name = readName(key, 'provide')
    const existing = state.entries.get(name)
    if (existing?.definition)
      throw new DuplicateServiceError(`The transaction already provides '${name}'.`)

    assertNotReserved(state, name)
    const read = readDefinition(name, option)
    const entry = entryOf(state, name, false)
    entry.exclusive ||= isExclusiveKey(key)
    // A provide without its own edges uses the edges of the declaration.
    const definition: ServiceDefinition = read.edges.length === 0 && entry.declared ? { ...read, edges: entry.declared } : read
    const registration: RegistrationNode = createRegistration(node, name, entry.exclusive)
    entry.definition = definition
    entry.registration = registration
    entry.exported = definition.exported
    untracked(() => reserveKey(state, entry))

    return registrationApi(registration, { withdraw: () => withdrawEntry(entry, registration) })
  }) as TransactionProvide

  const replace = ((key: KeyReference, option: unknown): void => {
    assertOpen(state, 'replace')
    const name = readName(key, 'replace')
    if (state.entries.get(name)?.definition)
      throw new DuplicateServiceError(`The transaction already provides or replaces '${name}'.`)

    const target = registrationOf(key)
    const entry = entryOf(state, name, target?.exclusive ?? false)
    entry.definition = readDefinition(name, option, untracked(() => (target ? currentService(target) : slotOf(node, name)())))
    entry.replace = true
    entry.target = target
    // A replacement keeps the current registration of the key, so it reserves nothing.
    untracked(() => releaseReservation(entry))
  }) as TransactionReplace

  return Object.freeze({
    declare,
    provide,
    replace,
    commit: () => untracked(() => startCommit(state)),
    abort: () => untracked(() => abortTransaction(state, new TransactionIncompleteError('The transaction was aborted before the commit completed.'))),
  })
}
