import type { HookState, InstanceNode, RawHookHandler, UnitNode } from '../graph/graph'
import type { Decision, HookRun, UnitHook } from '../primitives/decision'
import type { TimeoutContext } from '../types'

import { HookTimeoutError } from '../diagnostics/errors'
import { timeoutHandlerOf } from '../graph/nodes'
import { emitRecord, recordTimeout } from '../graph/observers'
import { forwardAbort } from '../helpers/abort'
import { messageOf } from '../helpers/error-from'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'
import { createDecide, defaultDecision, validateDecision } from '../primitives/decision'
import { invokeUser } from './calls'
import { recordSignalOrigin } from './reentry'

function hookStateOf(instance: InstanceNode, hook: UnitHook): HookState {
  let state = instance.hookStates.get(hook)
  if (!state) {
    state = { attempt: 1, previous: undefined }
    instance.hookStates.set(hook, state)
  }

  return state
}

/** A requeue keeps the attempt count. Any other decision resets it. */
export function finishRun(instance: InstanceNode, hook: UnitHook, decision: Decision): void {
  const state = hookStateOf(instance, hook)
  state.previous = decision
  state.attempt = decision.kind === 'requeue' ? state.attempt + 1 : 1
}

export function recordDecision(unit: UnitNode, instance: InstanceNode, decision: Decision, ignored: boolean): void {
  emitRecord(unit.container, {
    type: 'decision',
    key: unit.name,
    owner: unit.container.owner,
    instanceId: instance.id,
    hook: decision.hook,
    decision: decision.kind,
    attempt: decision.attempt,
    ignored,
    ...withoutUndefined({ reason: decision.reason }),
  })
}

/**
 * Reports a failure of a callback that injeca stopped waiting for, after a timeout or a newer target. Nothing else gets the error, so injeca writes it with `logger.warn`.
 *
 * A failure with the reason of one of `signals` is not reported, because the callback only followed its abort.
 */
export function reportLateFailure(unit: UnitNode, source: UnitHook | 'effect', error: unknown, signals: ReadonlyArray<AbortSignal | undefined>): void {
  if (signals.some(signal => signal?.aborted && signal.reason === error))
    return

  const callback = source === 'effect' ? `An effect disposer of '${unit.name}'` : `The '${source}' hook of '${unit.name}'`
  unit.container.api.logger.warn(`${callback} failed after injeca stopped waiting for it: ${messageOf(error)}`)
}

/** Records the late decision of a hook run that injeca stopped waiting for. A late `fail` is reported with `reportLateFailure`. */
export function recordLateDecision(unit: UnitNode, instance: InstanceNode, decision: Decision, signals: ReadonlyArray<AbortSignal | undefined>): void {
  recordDecision(unit, instance, decision, true)
  if (decision.kind === 'fail')
    reportLateFailure(unit, decision.hook, decision.error, signals)
}

/**
 * Starts a hook run. Its signal aborts when a newer target supersedes it, when the instance is disposed, or when `timeout` aborts.
 * The signal has the reason of the first one. `end` removes the listeners.
 */
export function beginHookRun(instance: InstanceNode, timeout?: AbortSignal): { readonly signal: AbortSignal, readonly end: () => void } {
  const controller = new AbortController()
  const release = forwardAbort(controller, timeout ? [instance.controller.signal, timeout] : [instance.controller.signal])
  recordSignalOrigin(controller.signal, instance)
  instance.hookRun = controller

  return {
    signal: controller.signal,
    end: () => {
      release()
      if (instance.hookRun === controller)
        instance.hookRun = undefined
    },
  }
}

/** Calls one handler with a new hook context. A throw becomes `fail`. A value that is not a decision counts as `undefined`. A decision from another run, or of a kind that the hook does not accept, becomes `fail` with `invalid-decision`. */
export async function callHandler(
  unit: UnitNode,
  instance: InstanceNode,
  hook: UnitHook,
  handler: RawHookHandler,
  runSignal: AbortSignal,
  extras: object,
  call: <T>(fn: () => T | Promise<T>) => Promise<T> = invokeUser,
): Promise<Decision> {
  const state = hookStateOf(instance, hook)
  const run: HookRun = { unit: unit.name, instanceId: instance.id, hook, attempt: state.attempt, now: () => unit.container.runtime.clock.now() }
  const hookContext = Object.freeze({
    decide: createDecide(run),
    attempt: run.attempt,
    previous: state.previous,
    signal: runSignal,
    ...extras,
  })

  try {
    const value = await call(() => handler(hookContext))
    return validateDecision(run, value) ?? defaultDecision(run)
  }
  catch (error) {
    return createDecide(run).fail(error)
  }
}

export interface RunHandlersOptions {
  /** Runs every handler, also after a decision that is not `handled`. */
  readonly all?: boolean
  /** The index of the first handler to run. */
  readonly from?: number
  /** Gets the index of the handler that runs now, or that gave the last decision. */
  readonly progress?: { index: number }
  /** Ends the run before the next handler when it returns `true`. */
  readonly stopped?: () => boolean
}

/** Runs the handlers of `hook` in order. It stops at the first decision that is not `handled`, unless `all` is set. */
export async function runHandlers(unit: UnitNode, instance: InstanceNode, hook: UnitHook, runSignal: AbortSignal, extras: object, options: RunHandlersOptions = {}): Promise<Decision[]> {
  const decisions: Decision[] = []
  const handlers = [...instance.hooks[hook]]
  for (let index = options.from ?? 0; index < handlers.length; index++) {
    if (options.stopped?.())
      break
    if (options.progress)
      options.progress.index = index

    const decision = await callHandler(unit, instance, hook, handlers[index]!, runSignal, extras)
    decisions.push(decision)
    if (!options.all && decision.kind !== 'handled')
      break
  }

  return decisions
}

/**
 * Records a timeout of a `start` or `stop` hook in the observe stream, and returns the decision of the `onTimeout` handler.
 *
 * The handler runs synchronously. For `start`, a value that is not a decision of this hook, a promise, or no handler gives `fail` with `hook-timeout`.
 * For `stop`, they give `handled` with the timeout as the reason, so that the stop continues and its callers do not fail. A throw gives `fail` for both hooks.
 */
export function decideTimeout(unit: UnitNode, instance: InstanceNode, hook: 'start' | 'stop', timeoutMs: number): Decision {
  const state = hookStateOf(instance, hook)
  const run: HookRun = { unit: unit.name, instanceId: instance.id, hook, attempt: state.attempt, now: () => unit.container.runtime.clock.now() }
  const decide = createDecide(run)
  const error = new HookTimeoutError(`The '${hook}' hook of '${unit.name}' did not settle within ${timeoutMs}ms.`, hook, timeoutMs)
  recordTimeout(unit.container, { key: unit.name, instanceId: instance.id, hook, timeoutMs, attempt: state.attempt, reason: error.message })

  const fallback = (): Decision => hook === 'stop' ? decide.handled({ reason: error.message }) : decide.fail(error, { reason: error.message })
  const handler = timeoutHandlerOf(unit)
  if (!handler)
    return fallback()

  try {
    const value = untracked(() => handler(Object.freeze({ hook, timeoutMs, attempt: state.attempt, previous: state.previous, decide }) as TimeoutContext))
    return validateDecision(run, value) ?? fallback()
  }
  catch (handlerError) {
    return decide.fail(handlerError, { reason: `The onTimeout handler of '${unit.name}' threw.` })
  }
}
