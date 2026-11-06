import type { ContainerNode, ServiceNode } from '../graph/graph'
import type { CleanupFrame } from '../helpers/cleanup-context'

import { emitRecord } from '../graph/observers'
import { signalSources } from '../helpers/abort'

/** The service of each signal that injeca gives to a run: the build signal of an instance, and the signal of each hook run. */
const signalOrigins = new WeakMap<AbortSignal, ServiceNode>()

/** The service of each cleanup frame of a teardown. */
const frameServices = new WeakMap<CleanupFrame, ServiceNode>()

/** Records that `signal` belongs to the runs of `service`. A signal from `anySignal` or `withTimeout` on top of it keeps this origin. */
export function recordSignalOrigin(signal: AbortSignal, service: ServiceNode): void {
  signalOrigins.set(signal, service)
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
}

/**
 * Finds out whether a `stop()` or `dispose()` of `target` comes from the cleanup chain of `target` or of a descendant. Such a call cannot wait, because the wait includes the caller.
 *
 * - With `signal`: the signal, or a signal that it comes from, belongs to a service of the subtree that is `stopping`.
 * - Without it: the synchronous part of a teardown of a service of the subtree, or of a container effect of the subtree, makes the call.
 *
 * A call without a signal after an `await` is not found. A configured `stop` timeout ends that cleanup.
 */
export function findReentry(target: ContainerNode, signal: AbortSignal | undefined): Reentry | undefined {
  if (signal) {
    for (const source of signalSources(signal)) {
      const service = signalOrigins.get(source)
      if (service && within(service.container, target) && service.signals.phase() === 'stopping')
        return { service }
    }
  }

  const { context } = target.runtime
  for (let frame = context.current(); frame; frame = frame.parent) {
    const service = frame.active ? frameServices.get(frame) : undefined
    if (service && within(service.container, target))
      return { service }
  }

  return context.isActive(target) ? { service: undefined } : undefined
}

function describeOwner(container: ContainerNode): string {
  return JSON.stringify(container.owner)
}

/** Warns on the logger of `target` and sends a `reentrant-call` record. The call then resolves at once. */
export function reportReentry(target: ContainerNode, call: 'stop' | 'dispose', reentry: Reentry): void {
  const { service } = reentry
  const source = service ? `The cleanup of '${service.name}' in ${describeOwner(service.container)}` : `A container effect in ${describeOwner(target)}`
  const reason = `${source} called ${call}() of ${describeOwner(target)}, and the wait includes that cleanup. injeca resolved the call at once. The ${call === 'dispose' ? 'disposal' : 'stop'} continues.`

  target.api.logger.warn(reason)
  emitRecord(service?.container ?? target, {
    type: 'reentrant-call',
    key: service?.name ?? '',
    owner: (service?.container ?? target).owner,
    instanceId: service?.signals.instance()?.id,
    call,
    reason,
  })
}
