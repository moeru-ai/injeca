import type { RegistrationNode, SwapOutcome, UnitDefinition, UnitNode } from '../graph/graph'
import type { PendingSwap } from '../reconciler/swap'
import type { Registration, WithdrawOptions } from '../types'

import { ReplaceWhileStoppingError, WaitTimeoutError } from '../diagnostics/errors'
import { describeExplanations, explainUnit } from '../diagnostics/explain'
import { cancelPending, cancelSuccessor, createUnit, currentUnit, publishUnit, readDefinition, releaseUnit } from '../graph/nodes'
import { blockingFailure } from '../graph/resolvers/resolvers'
import { isTimeoutReason, readSignal } from '../helpers/abort'
import { createDeferred } from '../helpers/deferred'
import { batch, untracked } from '../helpers/signals'
import { onAbort } from '../helpers/waiter'
import { completeSwap, createSuccessor } from '../reconciler/swap'
import { withdrawRegistration } from './withdraw'

function outcomeResult(outcome: SwapOutcome, name: string): boolean {
  switch (outcome.kind) {
    case 'swapped':
      return true
    case 'cancelled':
      return false
    case 'failed':
      throw outcome.error
    case 'stopping':
      throw new ReplaceWhileStoppingError(`'${name}' started to stop before its replacement completed.`)
  }
}

/** Makes `unit` the current registration in place of `target`, in the caller's batch. */
export function takeOver(registration: RegistrationNode, target: UnitNode, unit: UnitNode): void {
  cancelPending(registration)
  target.replacedBy = unit
  releaseUnit(target)
  publishUnit(unit)
  registration.current = unit
}

/** Replaces a unit that has no serving instance. The new unit takes the slot at once. */
export function replaceAtOnce(registration: RegistrationNode, target: UnitNode, definition: UnitDefinition): UnitNode {
  let unit: UnitNode | undefined
  batch(() => {
    unit = createUnit({
      container: target.container,
      kind: 'unit',
      name: target.name,
      edges: definition.edges,
      build: definition.build,
      metadata: definition.metadata,
      policy: definition.policy,
      exclusive: target.exclusive,
      visibility: target.visibility,
      instances: target.instances,
      registration,
    })
    unit.signals.demanded(target.signals.demanded())
    target.container.units.add(unit)
    takeOver(registration, target, unit)
  })

  return unit!
}

/**
 * Replaces the per-container registration `target` with the unpublished registration `template`. Resolves with the outcome.
 *
 * Each running consumer unit gets a successor that builds and starts from `definition`. A successor that completes `start` waits.
 * When every successor waits, one batch publishes `template` and swaps in all successors. The other consumer units leave and build again on demand.
 * When one successor fails, all successors leave, `template` leaves, and the old registration and its consumer units do not change.
 * A consumer unit that leaves during the replacement, for example with its container, drops out of the batch.
 * A newer `replace` or a withdrawal cancels the replacement.
 */
export function replaceTemplate(registration: RegistrationNode, target: UnitNode, template: UnitNode): Promise<SwapOutcome> {
  const definition: UnitDefinition = { edges: template.edges, build: template.build, metadata: template.metadata, instances: 'per-container', visibility: 'local', policy: template.policy }
  const outcome = createDeferred<SwapOutcome>()
  const waiting = new Set<UnitNode>()
  const held = new Set<UnitNode>()
  let settled = false

  const finish = (result: SwapOutcome): void => {
    settled = true
    template.swap = undefined
    if (target.successor === template)
      target.successor = undefined
    if (registration.pending === template)
      registration.pending = undefined
    outcome.resolve(result)
  }
  // The successors leave. A held successor completed `start`, so the reconciler runs its `stop` hooks.
  const abandon = (result: SwapOutcome): void => {
    if (settled)
      return

    batch(() => {
      finish(result)
      for (const successor of [...waiting, ...held]) {
        successor.signals.present(false)
        successor.container.runtime.reconciler.markDirty(successor)
      }
      releaseUnit(template)
    })
  }
  const commitIfReady = (): void => {
    if (settled || waiting.size > 0)
      return

    batch(() => {
      finish({ kind: 'swapped' })
      takeOver(registration, target, template)
      for (const successor of held)
        completeSwap(successor)
    })
  }

  batch(() => {
    cancelPending(registration)
    // `cancelPending` of a newer replacement, or a withdrawal, cancels this replacement.
    template.swap = { target, held: false, settle: abandon }
    registration.pending = template
    target.successor = template

    for (const consumer of target.signals.consumers().values()) {
      if (!consumer.signals.serving())
        continue

      // A make-before-break rebuild of the consumer unit gives way to the replacement.
      cancelSuccessor(consumer)
      const { unit } = createSuccessor(consumer, definition, {
        template,
        onSettle: (successor, result) => {
          waiting.delete(successor)
          held.delete(successor)
          if (result.kind === 'failed')
            abandon(result)
          else if (result.kind !== 'swapped')
            commitIfReady()
        },
        ready: (successor) => {
          waiting.delete(successor)
          held.add(successor)
          commitIfReady()
        },
      })
      waiting.add(unit)
    }
  })
  commitIfReady()

  return outcome.promise
}

/** Settles a replacement for its registration. */
function settleRegistration(registration: RegistrationNode): (unit: UnitNode, outcome: SwapOutcome) => void {
  return (unit, outcome) => {
    if (registration.pending === unit)
      registration.pending = undefined
    if (outcome.kind === 'swapped')
      registration.current = unit
  }
}

/**
 * Starts the replacement of a running unit. The old instance serves until the new one completes `start`.
 * A transaction passes `extra`, and it sets `registration.pending` at its publish.
 */
export function replaceRunning(registration: RegistrationNode, target: UnitNode, definition: UnitDefinition, extra?: Pick<Parameters<typeof createUnit>[0], 'phase' | 'transaction'>): PendingSwap {
  const pending = createSuccessor(target, definition, { onSettle: settleRegistration(registration), extra })
  if (!extra?.transaction) {
    cancelPending(registration)
    registration.pending = pending.unit
  }

  return pending
}

/**
 * The rejection of a `replace()` that `reason` aborted, as `waitFor` and `resolve` map a reason.
 * A timeout reason gives `wait-timeout` with the reason as `cause`. Its message explains the `waiting` units. Another reason is the rejection itself.
 */
function replaceAbortError(name: string, reason: unknown, waiting: () => readonly UnitNode[]): unknown {
  if (!isTimeoutReason(reason))
    return reason

  const explanations = waiting().map(explainUnit)
  const details = explanations.length > 0 ? ` The replacement is not running:\n${describeExplanations(explanations)}` : ''
  return new WaitTimeoutError(`replace('${name}') timed out before the swap.${details}`, { cause: reason })
}

/** The new units that a replacement waits for: `pending` itself, or each consumer successor of the per-container template `pending`. */
function waitingUnits(target: UnitNode, pending: UnitNode): readonly UnitNode[] {
  if (target.instances !== 'per-container')
    return [pending]

  const successors: UnitNode[] = []
  for (const consumer of target.signals.consumers().values()) {
    const successor = consumer.successor
    if (successor?.template === pending && successor.signals.present())
      successors.push(successor)
  }

  return successors
}

/**
 * Waits for the outcome of the pending replacement `pending` of `target`. When `signal` aborts first, it cancels the replacement, as a newer `replace` does.
 * Then it rejects with the reason, or with `wait-timeout` for a timeout reason. Its message explains the new units, read before the cancel.
 *
 * A required dependency of a new unit that failed, directly or through a pending provider, also cancels the replacement.
 * Then it rejects with the error of that failure, as `resolve` does. The check runs after each drain, also for a failure before the call.
 * A newer `replace` or a withdrawal still resolves `false`. The listeners go when the outcome settles.
 */
async function awaitOutcome(registration: RegistrationNode, target: UnitNode, pending: UnitNode, outcome: Promise<SwapOutcome>, signal: AbortSignal | undefined): Promise<boolean> {
  let rejection: { readonly error: unknown } | undefined
  const cancel = (error: () => unknown): void => {
    if (registration.pending !== pending || rejection)
      return

    rejection = { error: error() }
    batch(() => cancelPending(registration))
  }
  const removeAbort = onAbort(signal, reason => cancel(() => replaceAbortError(registration.name, reason, () => waitingUnits(target, pending))))
  const { reconciler } = target.container.runtime
  const removeDrained = reconciler.onDrained(() => {
    for (const unit of waitingUnits(target, pending)) {
      const failure = blockingFailure(unit)
      if (failure)
        return cancel(() => failure.error)
    }
  })
  reconciler.requestDrain()
  try {
    const result = await outcome
    if (result.kind === 'cancelled' && rejection)
      throw rejection.error

    return outcomeResult(result, registration.name)
  }
  finally {
    removeAbort()
    removeDrained()
  }
}

/** The `replace()` of a registration. */
async function replace(registration: RegistrationNode, option: unknown, options: unknown): Promise<boolean> {
  const signal = readSignal(options as { readonly signal?: unknown } | undefined, 'replace')
  const target = untracked(() => currentUnit(registration))
  if (!target)
    return false

  const definition = readDefinition(registration.name, option, target)
  if (signal?.aborted)
    throw replaceAbortError(registration.name, signal.reason, () => [])
  const phase = untracked(() => target.signals.phase())
  if (phase === 'stopping')
    throw new ReplaceWhileStoppingError(`'${registration.name}' is stopping. Wait until it stops, then call provide.`)

  if (target.instances === 'per-container') {
    let template: UnitNode | undefined
    const outcome = untracked(() => {
      batch(() => {
        template = createUnit({
          container: target.container,
          kind: 'unit',
          name: target.name,
          edges: definition.edges,
          build: definition.build,
          metadata: definition.metadata,
          policy: definition.policy,
          exclusive: target.exclusive,
          visibility: target.visibility,
          instances: 'per-container',
          registration,
        })
        target.container.units.add(template)
      })
      return replaceTemplate(registration, target, template!)
    })
    return awaitOutcome(registration, target, template!, outcome, signal)
  }
  if (phase !== 'running') {
    untracked(() => replaceAtOnce(registration, target, definition))
    return true
  }

  const pending = untracked(() => replaceRunning(registration, target, definition))
  return awaitOutcome(registration, target, pending.unit, pending.outcome, signal)
}

const registrations = new WeakMap<object, RegistrationNode>()

/** The registration behind a result of `provide`, or `undefined` for any other value. */
export function registrationOf(key: unknown): RegistrationNode | undefined {
  return typeof key === 'object' && key !== null ? registrations.get(key) : undefined
}

/** Creates the public result of `provide`: the typed key with `withdraw()` and `replace()`. A transaction passes its own `withdraw`. */
export function registrationApi(registration: RegistrationNode, overrides: { readonly withdraw?: (options?: WithdrawOptions) => Promise<boolean> } = {}): Registration<string, unknown, undefined> {
  const api: Registration<string, unknown, undefined> = Object.freeze({
    key: registration.name,
    ...(registration.exclusive ? { exclusive: true } : {}),
    withdraw: overrides.withdraw ?? ((options?: WithdrawOptions) => withdrawRegistration(registration, options)),
    replace: ((option: unknown, options?: unknown) => replace(registration, option, options)) as Registration<string, unknown, undefined>['replace'],
  })
  registrations.set(api, registration)

  return api
}
