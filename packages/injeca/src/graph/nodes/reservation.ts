import type { TransactionEntry, TransactionNode } from '../graph'

import { batch } from '../../helpers/signals'
import { addDeclaration, removeDeclaration } from '../resolvers/exclusive'
import { createUnit } from './unit'

/**
 * Reserves the exclusive key of a transaction entry until the commit or the abort.
 *
 * The reservation is a declaration without a slot. Consumers cannot resolve it. An exclusive conflict counts it, so a provider of the key in another container of the resolution area goes to `conflict`.
 * The reservation of a parent-visible key counts in the resolution area of the parent container, as the published unit does.
 * A plain key needs no reservation. In the same container, `provide` checks the open transactions and fails with `duplicate-unit`.
 */
export function reserveKey(transaction: TransactionNode, entry: TransactionEntry): void {
  if (!entry.exclusive || entry.replace)
    return
  // A `tx.provide` with `visibility: 'parent'` after a `tx.declare` moves the reservation to the resolution area of the parent container.
  if (entry.reservation?.visibility === entry.visibility)
    return
  releaseReservation(entry)

  batch(() => {
    const reservation = createUnit({
      container: transaction.container,
      kind: 'unit',
      name: entry.name,
      edges: [],
      build: () => undefined,
      exclusive: true,
      visibility: entry.visibility,
      phase: 'declared',
      transaction,
    })
    entry.reservation = reservation
    addDeclaration(reservation)
  })
}

/** Removes the reservation of a transaction entry. The commit calls it in the batch of its publish. */
export function releaseReservation(entry: TransactionEntry): void {
  const reservation = entry.reservation
  if (!reservation)
    return

  entry.reservation = undefined
  batch(() => {
    reservation.signals.present(false)
    removeDeclaration(reservation)
  })
  reservation.disposeEffects()
}

/** Removes the reservations of all entries of a transaction. */
export function releaseReservations(transaction: TransactionNode): void {
  batch(() => {
    for (const entry of transaction.entries.values())
      releaseReservation(entry)
  })
}

/** Tells whether an open or committing transaction of the container, other than `except`, has an entry that reserves `name`. */
export function reservedBy(transactions: Iterable<TransactionNode>, name: string, except?: TransactionNode): TransactionNode | undefined {
  for (const transaction of transactions) {
    if (transaction === except || (transaction.state !== 'open' && transaction.state !== 'committing'))
      continue

    const entry = transaction.entries.get(name)
    if (entry && !entry.replace)
      return transaction
  }

  return undefined
}
