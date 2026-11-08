import type { ContainerNode, RegistrationNode, TransactionEntry, TransactionNode, UnitDefinition, UnitNode } from '../graph/graph'
import type { TransactionMembers } from '../reconciler/commit'
import type { Container, DeclareOptions, KeyReference, Registration, Transaction, TransactionCommitOptions, TransactionProvide, TransactionReplace, WithdrawOptions } from '../types'

import { DuplicateUnitError, InvalidArgumentError, ReplaceWhileStoppingError, StaleRegistrationError, TransactionIncompleteError } from '../diagnostics/errors'
import { assertActive, cancelPending, createRegistration, currentUnit, nodeOf, readDefinition, readEdges, releaseReservation, releaseReservations, reservedBy, reserveKey, setPhase } from '../graph/nodes'
import { slotOf } from '../graph/resolvers/resolvers'
import { readSignal } from '../helpers/abort'
import { batch, untracked } from '../helpers/signals'
import { createWaiter, onAbort } from '../helpers/waiter'
import { abortTransaction, buildMembers, orderMembers, rollbackMembers, startMembers } from '../reconciler/commit'
import { isExclusiveKey, normalizeName } from './keys'
import { assertNoDuplicate, publishRegistration, unitOf } from './provide'
import { registrationApi, registrationOf, replaceRunning, replaceTemplate, takeOver } from './replace'
import { withdrawRegistration } from './withdraw'

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
  readonly unit: UnitNode
  /** The unit that a `tx.replace` replaces. */
  readonly target?: UnitNode
}

/** The unit that a `tx.replace` names now. A stale registration, or a key without a registration, fails. */
function replaceTarget(container: ContainerNode, entry: TransactionEntry): UnitNode {
  const target = entry.target ? currentUnit(entry.target) : slotOf(container, entry.name)()
  if (!target || !target.signals.present())
    throw new StaleRegistrationError(`The transaction replaces '${entry.name}', but the container has no current registration for it.`)
  if (target.signals.phase() === 'stopping')
    throw new ReplaceWhileStoppingError(`The transaction replaces '${entry.name}', but it is stopping.`)

  return target
}

/** Checks the entries and creates the units of a commit. The units are not published. */
function createMembers(transaction: TransactionNode): Member[] {
  const { container } = transaction
  assertActive(container, 'commit a transaction')

  const incomplete = [...transaction.entries.values()].filter(entry => !entry.definition && !entry.optional)
  if (incomplete.length > 0)
    throw new TransactionIncompleteError(`These declared units have no provide: ${incomplete.map(entry => `'${entry.name}'`).join(', ')}.`)

  const entries = [...transaction.entries.values()].filter(entry => entry.definition)
  const targets = new Map<TransactionEntry, UnitNode>()
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
        members.push({ entry, unit: unitOf(container, entry.name, definition, entry.exclusive, { ...extra, registration: entry.registration }) })
        continue
      }

      const registration = target.registration ?? createRegistration(container, entry.name, target.exclusive)
      const unit = target.signals.phase() === 'running' && target.instances === 'shared'
        ? replaceRunning(registration, target, definition, extra).unit
        : unitOf(container, entry.name, { ...definition, instances: target.instances, visibility: target.visibility }, target.exclusive, { ...extra, registration })
      members.push({ entry, unit, target })
    }
  })

  return members
}

/** Publishes the members in one batch. A built member goes to `starting`, the others to `pending`. The reservations end in the same batch. */
function publishMembers(transaction: TransactionNode, members: readonly Member[], built: ReadonlySet<UnitNode>): void {
  batch(() => {
    releaseReservations(transaction)
    for (const { unit, target } of members) {
      unit.transaction = undefined
      const registration = unit.registration
      if (target && registration && unit.swap) {
        // The new unit swaps in after it completes `start`.
        cancelPending(registration)
        registration.pending = unit
      }
      else if (target && registration && target.instances === 'per-container') {
        // The commit does not wait for the swap, as for a running unit.
        void replaceTemplate(registration, target, unit)
      }
      else if (target && registration) {
        takeOver(registration, target, unit)
      }
      else {
        publishRegistration(unit.container, unit)
        if (registration)
          registration.current = unit
      }

      if (unit.signals.present())
        setPhase(unit, built.has(unit) ? 'starting' : 'pending', { reason: built.has(unit) ? 'The transaction committed.' : 'The transaction committed. The unit waits for its dependencies.' })
    }
  })
}

async function commit(transaction: TransactionNode): Promise<void> {
  const members = untracked(() => createMembers(transaction))
  const byName: TransactionMembers = new Map(members.map(member => [member.unit.name, member.unit]))
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

/**
 * Commits `transaction`. When `signal` aborts before the publish, the transaction aborts with the reason, and the result rejects at once.
 * The rollback continues: the build in progress gets the abort on its `signal`, and the key reservations end when the rollback settles.
 */
function startCommit(transaction: TransactionNode, options: unknown): Promise<void> {
  let signal: AbortSignal | undefined
  try {
    signal = readSignal(options as { readonly signal?: unknown } | undefined, 'commit')
  }
  catch (error) {
    return Promise.reject(error)
  }
  if (transaction.state !== 'open')
    return Promise.reject(new InvalidArgumentError(`The transaction is ${transaction.state === 'aborted' ? 'aborted' : 'already committed'}.`))
  if (signal?.aborted) {
    void abortTransaction(transaction, signal.reason)
    return Promise.reject(signal.reason)
  }

  transaction.state = 'committing'
  const committed = commit(transaction).catch((error: unknown) => {
    if (transaction.state !== 'done') {
      transaction.state = 'aborted'
      transaction.container.transactions.delete(transaction)
      untracked(() => releaseReservations(transaction))
    }
    throw error
  })
  transaction.settled = committed.then(() => {}, () => {})
  if (!signal)
    return committed

  const waiter = createWaiter<void>(undefined)
  waiter.defer(onAbort(signal, (reason) => {
    // After the publish, the abort has no effect.
    if (transaction.state !== 'committing')
      return

    void abortTransaction(transaction, reason)
    waiter.reject(reason)
  }))
  committed.then(waiter.resolve, waiter.reject)
  return waiter.promise
}

/** Throws `duplicate-unit` when another open transaction of the container declares or provides `name`. */
function assertNotReserved(transaction: TransactionNode, name: string): void {
  if (reservedBy(transaction.container.transactions, name, transaction))
    throw new DuplicateUnitError(`Another open transaction of the container reserves '${name}'.`)
}

function assertOpen(transaction: TransactionNode, action: string): void {
  if (transaction.state !== 'open')
    throw new InvalidArgumentError(`Cannot ${action} after the transaction committed or aborted.`)
}

function entryOf(transaction: TransactionNode, name: string, exclusive: boolean): TransactionEntry {
  let entry = transaction.entries.get(name)
  if (!entry) {
    entry = { name, declared: undefined, optional: false, definition: undefined, replace: false, target: undefined, registration: undefined, exclusive, visibility: 'local', reservation: undefined }
    transaction.entries.set(name, entry)
  }

  return entry
}

/**
 * Creates a transaction for `container`.
 *
 * `declare` reserves units. `provide` and `replace` add units. Nothing is visible to consumers before `commit()`.
 * `commit()` builds the units in dependency order and publishes them in one batch. Then the `start` hooks run.
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
   * During the commit, it waits for the commit, then withdraws the published unit with `options`.
   */
  const withdrawEntry = async (entry: TransactionEntry, registration: RegistrationNode, options: WithdrawOptions | undefined): Promise<boolean> => {
    if (state.state === 'open') {
      if (entry.registration !== registration)
        return false

      entry.definition = undefined
      entry.registration = undefined
      entry.visibility = 'local'
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

    return withdrawRegistration(registration, options)
  }

  const provide = ((key: KeyReference, option: unknown): Registration<string, unknown, undefined> => {
    assertOpen(state, 'provide')
    const name = readName(key, 'provide')
    const existing = state.entries.get(name)
    if (existing?.definition)
      throw new DuplicateUnitError(`The transaction already provides '${name}'.`)

    assertNotReserved(state, name)
    const read = readDefinition(name, option)
    const entry = entryOf(state, name, false)
    entry.exclusive ||= isExclusiveKey(key)
    // A provide without its own edges uses the edges of the declaration.
    const definition: UnitDefinition = read.edges.length === 0 && entry.declared ? { ...read, edges: entry.declared } : read
    const registration: RegistrationNode = createRegistration(node, name, entry.exclusive)
    entry.definition = definition
    entry.registration = registration
    entry.visibility = definition.visibility
    untracked(() => reserveKey(state, entry))

    return registrationApi(registration, { withdraw: options => withdrawEntry(entry, registration, options) })
  }) as TransactionProvide

  const replace = ((key: KeyReference, option: unknown): void => {
    assertOpen(state, 'replace')
    const name = readName(key, 'replace')
    if (state.entries.get(name)?.definition)
      throw new DuplicateUnitError(`The transaction already provides or replaces '${name}'.`)

    const target = registrationOf(key)
    const entry = entryOf(state, name, target?.exclusive ?? false)
    entry.definition = readDefinition(name, option, untracked(() => (target ? currentUnit(target) : slotOf(node, name)())))
    entry.replace = true
    entry.target = target
    // A replacement keeps the current registration of the key, so it reserves nothing.
    untracked(() => releaseReservation(entry))
  }) as TransactionReplace

  return Object.freeze({
    declare,
    provide,
    replace,
    commit: (options?: TransactionCommitOptions) => untracked(() => startCommit(state, options)),
    abort: () => untracked(() => abortTransaction(state, new TransactionIncompleteError('The transaction was aborted before the commit completed.'))),
  })
}
