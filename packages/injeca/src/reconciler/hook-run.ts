import type { HookState, InstanceNode, RawHookHandler, ServiceNode } from '../graph/graph'
import type { Decision, HookRun, ServiceHook } from '../primitives/decision'
import type { TimeoutContext } from '../types'

import { HookTimeoutError } from '../diagnostics/errors'
import { timeoutHandlerOf } from '../graph/nodes'
import { emitRecord } from '../graph/observers'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'
import { createDecide, defaultDecision, validateDecision } from '../primitives/decision'
import { invokeUser } from './calls'

function hookStateOf(instance: InstanceNode, hook: ServiceHook): HookState {
  let state = instance.hookStates.get(hook)
  if (!state) {
    state = { attempt: 1, previous: undefined }
    instance.hookStates.set(hook, state)
  }

  return state
}

/** A requeue keeps the attempt count. Any other decision resets it. */
export function finishRun(instance: InstanceNode, hook: ServiceHook, decision: Decision): void {
  const state = hookStateOf(instance, hook)
  state.previous = decision
  state.attempt = decision.kind === 'requeue' ? state.attempt + 1 : 1
}

export function recordDecision(service: ServiceNode, instance: InstanceNode, decision: Decision, ignored: boolean): void {
  emitRecord(service.container, {
    type: 'decision',
    key: service.name,
    owner: service.container.owner,
    instanceId: instance.id,
    hook: decision.hook,
    decision: decision.kind,
    attempt: decision.attempt,
    ignored,
    ...withoutUndefined({ reason: decision.reason }),
  })
}

/** Starts a hook run. Its signal aborts when a newer target supersedes it, when it times out, or when the instance is disposed. */
export function beginHookRun(instance: InstanceNode): { readonly signal: AbortSignal, readonly abort: (reason: unknown) => void, readonly end: () => void } {
  const controller = new AbortController()
  const parent = instance.controller.signal
  const forward = () => controller.abort(parent.reason)
  if (parent.aborted)
    forward()
  else
    parent.addEventListener('abort', forward, { once: true })
  instance.hookRun = controller

  return {
    signal: controller.signal,
    abort: reason => controller.abort(reason),
    end: () => {
      parent.removeEventListener('abort', forward)
      if (instance.hookRun === controller)
        instance.hookRun = undefined
    },
  }
}

/** Calls one handler with a new hook context. A throw becomes `fail`. A value that is not a decision counts as `undefined`. A decision from another run, or of a kind that the hook does not accept, becomes `fail` with `invalid-decision`. */
export async function callHandler(
  service: ServiceNode,
  instance: InstanceNode,
  hook: ServiceHook,
  handler: RawHookHandler,
  runSignal: AbortSignal,
  extras: object,
  call: <T>(fn: () => T | Promise<T>) => Promise<T> = invokeUser,
): Promise<Decision> {
  const state = hookStateOf(instance, hook)
  const run: HookRun = { service: service.name, instanceId: instance.id, hook, attempt: state.attempt, now: () => service.container.runtime.clock.now() }
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
export async function runHandlers(service: ServiceNode, instance: InstanceNode, hook: ServiceHook, runSignal: AbortSignal, extras: object, options: RunHandlersOptions = {}): Promise<Decision[]> {
  const decisions: Decision[] = []
  const handlers = [...instance.hooks[hook]]
  for (let index = options.from ?? 0; index < handlers.length; index++) {
    if (options.stopped?.())
      break
    if (options.progress)
      options.progress.index = index

    const decision = await callHandler(service, instance, hook, handlers[index]!, runSignal, extras)
    decisions.push(decision)
    if (!options.all && decision.kind !== 'handled')
      break
  }

  return decisions
}

/**
 * Records a timeout of a `start` or `stop` hook in the observe stream, and returns the decision of the `onTimeout` handler.
 *
 * The handler runs synchronously. A value that is not a decision of this hook, a promise, a throw, or no handler gives `fail` with `hook-timeout`.
 */
export function decideTimeout(service: ServiceNode, instance: InstanceNode, hook: 'start' | 'stop', timeoutMs: number): Decision {
  const state = hookStateOf(instance, hook)
  const run: HookRun = { service: service.name, instanceId: instance.id, hook, attempt: state.attempt, now: () => service.container.runtime.clock.now() }
  const decide = createDecide(run)
  const error = new HookTimeoutError(`The '${hook}' hook of '${service.name}' did not settle within ${timeoutMs}ms.`, hook, timeoutMs)
  emitRecord(service.container, {
    type: 'timeout',
    key: service.name,
    owner: service.container.owner,
    instanceId: instance.id,
    hook,
    timeoutMs,
    attempt: state.attempt,
    reason: error.message,
  })

  const handler = timeoutHandlerOf(service)
  if (!handler)
    return decide.fail(error, { reason: error.message })

  try {
    const value = untracked(() => handler(Object.freeze({ hook, timeoutMs, attempt: state.attempt, previous: state.previous, decide }) as TimeoutContext))
    return validateDecision(run, value) ?? decide.fail(error, { reason: error.message })
  }
  catch (handlerError) {
    return decide.fail(handlerError, { reason: `The onTimeout handler of '${service.name}' threw.` })
  }
}
