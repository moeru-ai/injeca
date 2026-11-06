import type { RegistrationNode, UnitNode } from '../graph/graph'

import { awaitWithdrawal, releasePresent, releaseRegistration } from '../graph/nodes'
import { recordAbortedWait } from '../graph/observers'
import { abortable, readSignal } from '../helpers/abort'
import { untracked } from '../helpers/signals'
import { findWithdrawReentry, reportReentry } from '../reconciler/reentry'

/**
 * Runs a `withdraw()` call. `release` releases the unit and returns it, or `undefined` when there is nothing to withdraw.
 *
 * - Resolves `true` after the withdrawal, and rejects with the teardown errors.
 * - When `options.signal` aborts, it rejects with the reason and stops waiting. The withdrawal continues. An aborted signal still starts it.
 * - A call from a cleanup that the withdrawal waits for warns, sends a `reentrant-call` record, and resolves `true` at once.
 */
function withdrawWith(release: () => UnitNode | undefined, options: unknown): Promise<boolean> {
  let signal: AbortSignal | undefined
  try {
    signal = readSignal(options as { readonly signal?: unknown } | undefined, 'withdraw')
  }
  catch (error) {
    return Promise.reject(error)
  }

  const unit = release()
  if (!unit)
    return Promise.resolve(false)

  const withdrawal = awaitWithdrawal(unit).then(() => true)
  const reentry = untracked(() => findWithdrawReentry(unit, signal))
  if (reentry) {
    untracked(() => reportReentry(unit.container, 'withdraw', reentry, `'${unit.name}' in ${JSON.stringify(unit.container.owner)}`))
    // The caller does not get the result. The teardown errors stay in the observe stream and the phase of the unit.
    withdrawal.catch(() => {})
    return Promise.resolve(true)
  }

  return abortable(withdrawal, signal, (reason) => {
    recordAbortedWait(untracked(() => unit.signals.phase()) === 'withdrawn' ? [] : [unit], 'withdraw', reason)
    return reason
  })
}

/** The `withdraw()` of a registration. Resolves `false` for a stale registration. */
export function withdrawRegistration(registration: RegistrationNode, options?: unknown): Promise<boolean> {
  return withdrawWith(() => releaseRegistration(registration), options)
}

/** The `withdraw()` of an invocation. Resolves `false` when it is already withdrawn. */
export function withdrawInvocation(unit: UnitNode, options?: unknown): Promise<boolean> {
  return withdrawWith(() => releasePresent(unit) ? unit : undefined, options)
}
