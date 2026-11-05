import type { HookState, InstanceNode, RawHookHandler, ServiceNode } from '../graph/graph'
import type { Decision, HookRun, ServiceHook } from '../primitives/decision'

import { emitRecord } from '../graph/observers'
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

/** Starts a hook run. Its signal aborts when a newer target supersedes it, or when the instance is disposed. */
export function beginHookRun(instance: InstanceNode): { readonly signal: AbortSignal, readonly end: () => void } {
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

/** Runs the handlers of `hook` in order. It stops at the first decision that is not `handled`, unless `all` is set. */
export async function runHandlers(service: ServiceNode, instance: InstanceNode, hook: ServiceHook, runSignal: AbortSignal, extras: object, all = false): Promise<Decision[]> {
  const decisions: Decision[] = []
  for (const handler of [...instance.hooks[hook]]) {
    const decision = await callHandler(service, instance, hook, handler, runSignal, extras)
    decisions.push(decision)
    if (!all && decision.kind !== 'handled')
      break
  }

  return decisions
}
