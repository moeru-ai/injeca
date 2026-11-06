import type { ContainerNode, InstanceNode, UnitNode } from '../graph/graph'
import type { CleanupContext, CleanupFrame } from '../helpers/cleanup-context'

import { emitRecord } from '../graph/observers'
import { signalSources } from '../helpers/abort'

/** The instance of each signal that injeca gives to a run: the build signal of an instance, and the signal of each hook run. */
const signalOrigins = new WeakMap<AbortSignal, InstanceNode>()

/** The unit of each cleanup frame of a teardown. */
const frameUnits = new WeakMap<CleanupFrame, UnitNode>()

/** Records that `signal` belongs to the runs of `instance`. A signal from `anySignal` or `withTimeout` on top of it keeps this origin. */
export function recordSignalOrigin(signal: AbortSignal, instance: InstanceNode): void {
  signalOrigins.set(signal, instance)
}

/** Creates the cleanup frame of a teardown of `unit`, inside `parent`. The teardown sets `active` to `false` when it ends. */
export function unitFrame(unit: UnitNode, parent: CleanupFrame | undefined): CleanupFrame {
  const frame: CleanupFrame = { owner: unit, parent, active: true }
  frameUnits.set(frame, unit)

  return frame
}

function within(container: ContainerNode, ancestor: ContainerNode): boolean {
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    if (current === ancestor)
      return true
  }

  return false
}

/** A `stop()`, `dispose()`, or `withdraw()` call from a cleanup that the call waits for. `unit` is the unit of the cleanup, or `undefined` for a container effect. */
export interface Reentry {
  readonly unit: UnitNode | undefined
  /** The instance of the cleanup, when the signal tells it. */
  readonly instance?: InstanceNode
}

/** The calls that find a re-entrant caller. */
export type ReentrantCall = 'stop' | 'dispose' | 'withdraw'

/** Finds a cleanup that `covers` names, by the origin of `signal`, then by the synchronous cleanup frames. The instance of a signal counts only while its teardown runs. */
function findCleanup(context: CleanupContext, signal: AbortSignal | undefined, covers: (unit: UnitNode, instance: InstanceNode | undefined) => boolean): Reentry | undefined {
  if (signal) {
    for (const source of signalSources(signal)) {
      const instance = signalOrigins.get(source)
      if (instance && instance.tearingDown && !instance.disposed && covers(instance.unit, instance))
        return { unit: instance.unit, instance }
    }
  }

  for (let frame = context.current(); frame; frame = frame.parent) {
    const unit = frame.active ? frameUnits.get(frame) : undefined
    if (unit && covers(unit, unit.signals.instance()))
      return { unit }
  }

  return undefined
}

/**
 * Tells whether the teardown of `instance` is part of a stop that waits for each unit that `stops` names.
 * It is when the unit of `instance` is such a unit, or when `instance` holds an instance of one, directly or through other instances.
 * The teardown of a held instance waits until its holders release it, so it waits for `instance` too.
 */
function waitedFor(instance: InstanceNode, stops: (unit: UnitNode) => boolean): boolean {
  const seen = new Set<InstanceNode>([instance])
  const queue = [instance]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!
    if (stops(current.unit))
      return true

    for (const provider of current.held) {
      if (!seen.has(provider)) {
        seen.add(provider)
        queue.push(provider)
      }
    }
  }

  return false
}

/** Finds a cleanup whose teardown the wait for the units that `stops` names includes. */
function findWaitedCleanup(context: CleanupContext, signal: AbortSignal | undefined, stops: (unit: UnitNode) => boolean): Reentry | undefined {
  return findCleanup(context, signal, (unit, instance) => stops(unit) || (instance !== undefined && waitedFor(instance, stops)))
}

/**
 * Finds out whether a `stop()` or `dispose()` of `target` comes from a cleanup that the call waits for. Such a call cannot wait, because the wait includes the caller.
 *
 * - The cleanup is of a unit of the subtree, or of a container effect of the subtree.
 * - Or the cleanup is of a unit outside the subtree that holds a unit that the call stops, directly or through other instances. That unit waits for its holders.
 *   `dispose()` also withdraws the consumer units of each per-container registration of the subtree, so they count for it.
 * - With `signal`: the signal, or a signal that it comes from, belongs to such an instance whose teardown runs.
 *   The check uses the instance, not the phase of its unit. So the teardown of a successor whose build failed, or of an old instance during a rebuild, counts too.
 * - Without it: the synchronous part of such a teardown makes the call.
 *
 * A call without a signal after an `await` is not found. A configured `stop` timeout ends that cleanup.
 */
export function findReentry(target: ContainerNode, call: 'stop' | 'dispose', signal: AbortSignal | undefined): Reentry | undefined {
  const { context } = target.runtime
  const stops = call === 'dispose'
    ? (unit: UnitNode) => within(unit.container, target) || (unit.template !== undefined && within(unit.template.container, target))
    : (unit: UnitNode) => within(unit.container, target)
  const found = findWaitedCleanup(context, signal, stops)
  if (found)
    return found

  return context.isActive(target) ? { unit: undefined } : undefined
}

/**
 * Finds out whether a `withdraw()` of `target` comes from a cleanup that the withdrawal waits for: of `target`, of a consumer unit of it, or of a unit that holds one of them, directly or through other instances.
 * The rules are the same as for `findReentry`.
 */
export function findWithdrawReentry(target: UnitNode, signal: AbortSignal | undefined): Reentry | undefined {
  return findWaitedCleanup(target.container.runtime.context, signal, unit => unit === target || unit.template === target)
}

function describeOwner(container: ContainerNode): string {
  return JSON.stringify(container.owner)
}

const actions: Readonly<Record<ReentrantCall, string>> = { stop: 'stop', dispose: 'disposal', withdraw: 'withdrawal' }

/**
 * Warns on the logger of `target` and sends a `reentrant-call` record. The call then resolves at once.
 * `subject` names the target of the call. It defaults to the owner of `target`.
 */
export function reportReentry(target: ContainerNode, call: ReentrantCall, reentry: Reentry, subject = describeOwner(target)): void {
  const { unit } = reentry
  const source = unit ? `The cleanup of '${unit.name}' in ${describeOwner(unit.container)}` : `A container effect in ${describeOwner(target)}`
  const reason = `${source} called ${call}() of ${subject}, and the wait includes that cleanup. injeca resolved the call at once. The ${actions[call]} continues.`

  target.api.logger.warn(reason)
  emitRecord(unit?.container ?? target, {
    type: 'reentrant-call',
    key: unit?.name ?? '',
    owner: (unit?.container ?? target).owner,
    instanceId: reentry.instance?.id ?? unit?.signals.instance()?.id,
    call,
    reason,
  })
}
