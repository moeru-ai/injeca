import type { TimeoutHandler } from '../../types'
import type { ContainerNode, Policy, UnitNode } from '../graph'

import { InvalidArgumentError } from '../../diagnostics/errors'

const emptyPolicy: Policy = Object.freeze({})

/** The policy option fields as read from the caller, before the checks. */
export interface PolicyFields {
  readonly maxAttempts: unknown
  readonly timeouts: unknown
  readonly onTimeout: unknown
}

function readMaxAttempts(owner: string, value: unknown): number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1))
    throw new InvalidArgumentError(`The maxAttempts option of ${owner} must be an integer of 1 or more. Got ${String(value)}.`)

  return value
}

function readTimeout(owner: string, hook: 'start' | 'stop', value: unknown): number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    throw new InvalidArgumentError(`The timeouts.${hook} option of ${owner} must be a finite number of 0 or more. Got ${String(value)}.`)

  return value
}

function readTimeouts(owner: string, value: unknown): Policy['timeouts'] {
  if (value === undefined)
    return undefined
  if (typeof value !== 'object' || value === null)
    throw new InvalidArgumentError(`The timeouts option of ${owner} must be an object.`)

  let fields: { start: unknown, stop: unknown }
  try {
    const source = value as Record<string, unknown>
    fields = { start: source.start, stop: source.stop }
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the timeouts option of ${owner}.`, { cause: error })
  }

  const start = readTimeout(owner, 'start', fields.start)
  const stop = readTimeout(owner, 'stop', fields.stop)
  return Object.freeze({ ...(start === undefined ? {} : { start }), ...(stop === undefined ? {} : { stop }) })
}

/**
 * Checks the retry and timeout options that a caller gave. `owner` names the caller in the messages, for example `'voice.speech'`.
 * A field that is `undefined` takes the value of `inherit`, so that a replacement keeps it.
 */
export function readPolicy(owner: string, fields: PolicyFields, inherit?: Policy): Policy {
  const maxAttempts = readMaxAttempts(owner, fields.maxAttempts) ?? inherit?.maxAttempts
  const timeouts = readTimeouts(owner, fields.timeouts) ?? inherit?.timeouts
  if (fields.onTimeout !== undefined && typeof fields.onTimeout !== 'function')
    throw new InvalidArgumentError(`The onTimeout option of ${owner} must be a function.`)
  const onTimeout = (fields.onTimeout as TimeoutHandler | undefined) ?? inherit?.onTimeout

  if (maxAttempts === undefined && timeouts === undefined && onTimeout === undefined)
    return emptyPolicy

  return Object.freeze({
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(timeouts === undefined ? {} : { timeouts }),
    ...(onTimeout === undefined ? {} : { onTimeout }),
  })
}

/** The value of the nearest container, from `container` up to the root, that sets it. */
function fromContainers<T>(container: ContainerNode | undefined, pick: (policy: Policy) => T | undefined): T | undefined {
  for (let current = container; current; current = current.parent) {
    const value = pick(current.policy)
    if (value !== undefined)
      return value
  }

  return undefined
}

/** The attempt limit of a requeue: the decision, then the unit, then the containers. `undefined` means no limit. */
export function maxAttemptsOf(unit: UnitNode, fromDecision: number | undefined): number | undefined {
  return fromDecision ?? unit.policy.maxAttempts ?? fromContainers(unit.container, policy => policy.maxAttempts)
}

/** The timeout of a hook: the unit, then the containers. `undefined` means no timeout. */
export function timeoutOf(unit: UnitNode, hook: 'start' | 'stop'): number | undefined {
  return unit.policy.timeouts?.[hook] ?? fromContainers(unit.container, policy => policy.timeouts?.[hook])
}

/** The timeout of a hook for the effects of `container`: the container, then its ancestors. `undefined` means no timeout. */
export function containerTimeoutOf(container: ContainerNode, hook: 'start' | 'stop'): number | undefined {
  return fromContainers(container, policy => policy.timeouts?.[hook])
}

/** The `onTimeout` handler: the unit, then the containers. */
export function timeoutHandlerOf(unit: UnitNode): TimeoutHandler | undefined {
  return unit.policy.onTimeout ?? fromContainers(unit.container, policy => policy.onTimeout)
}
