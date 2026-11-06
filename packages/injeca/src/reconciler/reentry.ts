import type { ContainerNode, InstanceNode, ServiceNode } from '../graph/graph'
import type { CleanupContext, CleanupFrame } from '../helpers/cleanup-context'

import { emitRecord } from '../graph/observers'
import { signalSources } from '../helpers/abort'

/** The instance of each signal that injeca gives to a run: the build signal of an instance, and the signal of each hook run. */
const signalOrigins = new WeakMap<AbortSignal, InstanceNode>()

/** The service of each cleanup frame of a teardown. */
const frameServices = new WeakMap<CleanupFrame, ServiceNode>()

/** Records that `signal` belongs to the runs of `instance`. A signal from `anySignal` or `withTimeout` on top of it keeps this origin. */
export function recordSignalOrigin(signal: AbortSignal, instance: InstanceNode): void {
  signalOrigins.set(signal, instance)
}

/** Creates the cleanup frame of a teardown of `service`, inside `parent`. The teardown sets `active` to `false` when it ends. */
export function serviceFrame(service: ServiceNode, parent: CleanupFrame | undefined): CleanupFrame {
  const frame: CleanupFrame = { owner: service, parent, active: true }
  frameServices.set(frame, service)

  return frame
}

function within(container: ContainerNode, ancestor: ContainerNode): boolean {
  for (let current: ContainerNode | undefined = container; current; current = current.parent) {
    if (current === ancestor)
      return true
  }

  return false
}

/** A `stop()` or `dispose()` call from the cleanup chain of its own container. `service` is the service of the cleanup, or `undefined` for a container effect. */
export interface Reentry {
  readonly service: ServiceNode | undefined
  /** The instance of the cleanup, when the signal tells it. */
  readonly instance?: InstanceNode
}

/** The calls that find a re-entrant caller. */
export type ReentrantCall = 'stop' | 'dispose' | 'withdraw'

/** Finds a cleanup that `covers` names, by the origin of `signal`, then by the synchronous cleanup frames. The instance of a signal counts only while its teardown runs. */
function findCleanup(context: CleanupContext, signal: AbortSignal | undefined, covers: (service: ServiceNode, instance: InstanceNode | undefined) => boolean): Reentry | undefined {
  if (signal) {
    for (const source of signalSources(signal)) {
      const instance = signalOrigins.get(source)
      if (instance && instance.tearingDown && !instance.disposed && covers(instance.service, instance))
        return { service: instance.service, instance }
    }
  }

  for (let frame = context.current(); frame; frame = frame.parent) {
    const service = frame.active ? frameServices.get(frame) : undefined
    if (service && covers(service, service.signals.instance()))
      return { service }
  }

  return undefined
}

/**
 * Finds out whether a `stop()` or `dispose()` of `target` comes from the cleanup chain of `target` or of a descendant. Such a call cannot wait, because the wait includes the caller.
 *
 * - With `signal`: the signal, or a signal that it comes from, belongs to an instance of the subtree whose teardown runs.
 *   The check uses the instance, not the phase of its service. So the teardown of a successor whose build failed, or of an old instance during a rebuild, counts too.
 * - Without it: the synchronous part of a teardown of a service of the subtree, or of a container effect of the subtree, makes the call.
 *
 * A call without a signal after an `await` is not found. A configured `stop` timeout ends that cleanup.
 */
export function findReentry(target: ContainerNode, signal: AbortSignal | undefined): Reentry | undefined {
  const { context } = target.runtime
  const found = findCleanup(context, signal, service => within(service.container, target))
  if (found)
    return found

  return context.isActive(target) ? { service: undefined } : undefined
}

/**
 * Tells whether the teardown of `instance` is part of the withdrawal of `target`.
 * It is when `instance` belongs to `target` or to a consumer service of it, or holds such an instance, directly or through other instances. The withdrawal waits for each holder.
 */
function partOfWithdrawal(instance: InstanceNode, target: ServiceNode): boolean {
  const seen = new Set<InstanceNode>([instance])
  const queue = [instance]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!
    if (current.service === target || current.service.template === target)
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

/**
 * Finds out whether a `withdraw()` of `target` comes from a cleanup that the withdrawal waits for: of `target`, of a consumer service of it, or of a service that holds it.
 * The rules are the same as for `findReentry`.
 */
export function findWithdrawReentry(target: ServiceNode, signal: AbortSignal | undefined): Reentry | undefined {
  return findCleanup(target.container.runtime.context, signal, (service, instance) =>
    service === target || service.template === target || (instance !== undefined && partOfWithdrawal(instance, target)))
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
  const { service } = reentry
  const source = service ? `The cleanup of '${service.name}' in ${describeOwner(service.container)}` : `A container effect in ${describeOwner(target)}`
  const reason = `${source} called ${call}() of ${subject}, and the wait includes that cleanup. injeca resolved the call at once. The ${actions[call]} continues.`

  target.api.logger.warn(reason)
  emitRecord(service?.container ?? target, {
    type: 'reentrant-call',
    key: service?.name ?? '',
    owner: (service?.container ?? target).owner,
    instanceId: reentry.instance?.id ?? service?.signals.instance()?.id,
    call,
    reason,
  })
}
