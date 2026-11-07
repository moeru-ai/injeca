import type { InstanceNode, RawBuildContext, RawHookHandler, StatusValue, UnitNode } from '../graph/graph'
import type { UnitHook } from '../primitives/decision'
import type { EffectSetup, OwnerRecord, StatusCause, UnitStatus } from '../types'

import { BuildAfterDisposeError, HookOutsideBuildError, InvalidArgumentError } from '../diagnostics/errors'
import { emitRecord } from '../graph/observers'
import { sameStatus } from '../graph/status'
import { untracked } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'

const unitHooks: ReadonlySet<string> = new Set<UnitHook>(['start', 'stop', 'dependency-change', 'dependency-status-change'])
const statuses: ReadonlySet<string> = new Set<UnitStatus>(['ready', 'degraded', 'unavailable'])

/** A cause chain longer than this is cut. It protects against a cyclic cause object. */
const maxCauseDepth = 32

function readOwner(value: unknown): OwnerRecord {
  try {
    const copy: unknown = structuredClone(value)
    if (typeof copy === 'object' && copy !== null && !Array.isArray(copy))
      return Object.freeze(copy as OwnerRecord)
  }
  catch (error) {
    throw new InvalidArgumentError('The owner of a status cause must be a serializable record.', { cause: error })
  }

  throw new InvalidArgumentError('The owner of a status cause must be a serializable record.')
}

function readStatusValue(value: unknown, what: string): UnitStatus {
  if (typeof value !== 'string' || !statuses.has(value))
    throw new InvalidArgumentError(`${what} must be 'ready', 'degraded', or 'unavailable'. Got ${String(value)}.`)

  return value as UnitStatus
}

function readReason(value: unknown, what: string): string | undefined {
  if (value !== undefined && typeof value !== 'string')
    throw new InvalidArgumentError(`${what} must be a string.`)

  return value
}

/** Reads a caller-owned cause chain once, into frozen records. */
function readCause(value: unknown, depth = 0): StatusCause | undefined {
  if (value === undefined || depth >= maxCauseDepth)
    return undefined
  if (typeof value !== 'object' || value === null)
    throw new InvalidArgumentError('A status cause must be an object with key, owner, and status.')

  let fields: { key: unknown, owner: unknown, status: unknown, reason: unknown, cause: unknown }
  try {
    const source = value as Record<string, unknown>
    fields = { key: source.key, owner: source.owner, status: source.status, reason: source.reason, cause: source.cause }
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the status cause.', { cause: error })
  }
  if (typeof fields.key !== 'string' || fields.key.length === 0)
    throw new InvalidArgumentError('The key of a status cause must be a non-empty string.')

  const reason = readReason(fields.reason, 'The reason of a status cause')
  const cause = readCause(fields.cause, depth + 1)

  return Object.freeze({
    key: fields.key,
    owner: readOwner(fields.owner ?? {}),
    status: readStatusValue(fields.status, 'The status of a status cause'),
    ...withoutUndefined({ reason, cause }),
  })
}

/** Reads the arguments of `setStatus` once. */
function readOwnStatus(unit: UnitNode, status: unknown, reasonOrOptions: unknown): StatusValue {
  const checked = readStatusValue(status, `The status of '${unit.name}'`)
  if (reasonOrOptions === undefined || typeof reasonOrOptions === 'string')
    return Object.freeze({ status: checked, ...withoutUndefined({ reason: reasonOrOptions }) })
  if (typeof reasonOrOptions !== 'object' || reasonOrOptions === null)
    throw new InvalidArgumentError(`The second argument of setStatus for '${unit.name}' must be a string or an object.`)

  let fields: { reason: unknown, cause: unknown }
  try {
    const options = reasonOrOptions as Record<string, unknown>
    fields = { reason: options.reason, cause: options.cause }
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the setStatus options of '${unit.name}'.`, { cause: error })
  }

  const reason = readReason(fields.reason, `The setStatus reason of '${unit.name}'`)
  const cause = readCause(fields.cause)

  return Object.freeze({
    status: checked,
    ...withoutUndefined({ reason, cause }),
  })
}

/** Creates the context that `build` gets. `on` is valid only while the build runs. `setStatus` stays valid after it. */
export function createBuildContext(unit: UnitNode, instance: InstanceNode): RawBuildContext {
  const dependsOn: Record<string, unknown> = {}
  for (const edge of unit.edges) {
    const binding = instance.bindings.get(edge.name)
    const state = instance.handled.get(edge.name)
    dependsOn[edge.name] = edge.optional
      ? (binding && state ? Object.freeze({ value: binding.value, status: state.status }) : undefined)
      : binding?.value
  }

  return Object.freeze({
    container: unit.container.api,
    name: unit.name,
    instanceId: instance.id,
    ...withoutUndefined({ consumer: unit.consumer }),
    dependsOn: Object.freeze(dependsOn),
    on: (hook: unknown, handler: RawHookHandler) => {
      if (!instance.building)
        throw new HookOutsideBuildError(`'on' was called for '${unit.name}' after its build settled.`)
      if (typeof hook !== 'string' || !unitHooks.has(hook))
        throw new InvalidArgumentError(`'${String(hook)}' is not a unit hook.`)
      if (typeof handler !== 'function')
        throw new InvalidArgumentError(`The '${hook}' handler of '${unit.name}' is not a function.`)

      instance.hooks[hook as UnitHook].push(handler)
    },
    effect: (setup: EffectSetup) => {
      if (instance.disposed)
        throw new BuildAfterDisposeError(`'effect' was called for '${unit.name}' after its instance was disposed.`)
      if (typeof setup !== 'function')
        throw new InvalidArgumentError(`The effect setup of '${unit.name}' is not a function.`)

      // The setup is a user callback.
      const disposer = untracked(setup)
      if (typeof disposer === 'function')
        instance.effects.push(disposer)
    },
    signal: instance.controller.signal,
    // `setStatus` stays valid after `build`, so it is an entry point.
    setStatus: (status: unknown, reasonOrOptions?: unknown) => untracked(() => {
      const next = readOwnStatus(unit, status, reasonOrOptions)
      if (instance.disposed) {
        emitRecord(unit.container, {
          type: 'ignored',
          call: 'setStatus',
          key: unit.name,
          owner: unit.container.owner,
          instanceId: instance.id,
          reason: `setStatus('${next.status}') was called after the instance was disposed.`,
        })
        return
      }
      if (!sameStatus(instance.signals.own(), next))
        instance.signals.own(next)
    }),
  })
}
