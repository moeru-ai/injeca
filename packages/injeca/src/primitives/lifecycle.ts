import type { ContainerNode, ServiceNode } from '../graph/graph'
import type { Container } from '../types'

import { StartTimeoutError } from '../diagnostics/errors'
import { describeExplanations, explainService } from '../diagnostics/explain'
import { affectedContainers, assertActive, nodeOf, setPhase } from '../graph/nodes'
import { recordAbortedWait } from '../graph/observers'
import { isTimeoutReason, onAbort, readSignal } from '../helpers/abort'
import { errorFrom } from '../helpers/error-from'
import { batch, untracked } from '../helpers/signals'
import { traceLoggerOf } from '../reconciler/calls'
import { findReentry, reportReentry } from '../reconciler/reentry'

const visibleKinds: ReadonlySet<ServiceNode['kind']> = new Set(['service', 'invocation'])

const transitionalPhases: ReadonlySet<string> = new Set(['building', 'starting', 'retrying', 'stopping'])

/** The result of one settle check. `'waiting'` checks again at the next drain. */
type SettleCheck = 'waiting' | { readonly kind: 'done' } | { readonly kind: 'failed', readonly errors: readonly unknown[] }

/** Lists the present services and invocations of `containers`. A `perConsumer` registration never runs, so it is not in the list. Its consumer services are. */
function presentServices(containers: readonly ContainerNode[]): ServiceNode[] {
  return containers.flatMap(container => [...container.services].filter(service => visibleKinds.has(service.kind) && service.signals.present() && !service.perConsumer))
}

/**
 * Runs `check` each time the work queue drains, until the result is not `'waiting'`.
 * When `signal` aborts first, it stops checking and rejects with the result of `onAborted`. An aborted signal rejects at once.
 */
function waitUntilSettled(containers: readonly ContainerNode[], check: (services: readonly ServiceNode[]) => SettleCheck, signal: AbortSignal | undefined, onAborted: (reason: unknown) => unknown): Promise<void> {
  const { reconciler } = containers[0]!.runtime

  return new Promise((done, fail) => {
    if (signal?.aborted) {
      fail(onAborted(signal.reason))
      return
    }

    let removeAbort = () => {}
    const stopListening = reconciler.onDrained(() => {
      const result = check(presentServices(containers))
      if (result === 'waiting')
        return

      stopListening()
      removeAbort()
      if (result.kind === 'done')
        done()
      else
        fail(errorFrom(result.errors, 'Start failed.'))
    })
    removeAbort = onAbort(signal, (reason) => {
      stopListening()
      fail(onAborted(reason))
    })
    reconciler.requestDrain()
  })
}

export interface StartOptions {
  /**
   * Ends the wait when the signal aborts. The services keep converging.
   * A timeout reason (`name === 'TimeoutError'`) rejects with `start-timeout` and the explanations. Another reason rejects as it is. There is no default.
   */
  signal?: AbortSignal
}

export interface StopOptions {
  /**
   * Ends the wait when the signal aborts, and rejects with the reason. The cleanups that did not settle keep running.
   * Each service that did not stop yet gets a `wait-aborted` record in the observe stream. There is no default.
   */
  signal?: AbortSignal
}

/**
 * Begins convergence of the container and of each child container that was started.
 *
 * Resolves when all their services and invocations are `running`. Rejects with the build and start errors.
 * A service in `failed` tries again. A required key without a provider keeps the promise pending, unless `options.signal` aborts.
 * A child container that was never started does not start. Call `start(child)` for it.
 */
export function start(container: Container, options?: StartOptions): Promise<void> {
  const node = nodeOf(container)
  assertActive(node, 'start')
  const signal = readSignal(options, 'start')

  node.enrolled = true
  const containers = affectedContainers(node)
  const settled = untracked(() => {
    batch(() => {
      for (const current of containers)
        current.signals.started(true)
      for (const service of presentServices(containers)) {
        if (service.signals.phase() === 'failed') {
          service.failure = undefined
          setPhase(service, 'pending', { reason: 'start() tries the failed service again.' })
        }
      }
    })

    return waitUntilSettled(containers, (services) => {
      if (services.every(service => service.signals.phase() === 'running'))
        return { kind: 'done' }
      if (services.some(service => transitionalPhases.has(service.signals.phase())))
        return 'waiting'

      const errors = services.flatMap(service => service.signals.phase() === 'failed' && service.failure ? [service.failure.error] : [])
      return errors.length > 0 ? { kind: 'failed', errors } : 'waiting'
    }, signal, (reason) => {
      if (!isTimeoutReason(reason))
        return reason

      const explanations = presentServices(containers).filter(service => service.signals.phase() !== 'running').map(explainService)
      return new StartTimeoutError(`start() timed out. These services are not running:\n${describeExplanations(explanations)}`, explanations, { cause: reason })
    })
  })

  return settled.then(() => traceLoggerOf(container)?.running())
}

/**
 * Stops all instances of the container and of each child container that was started. Dependents stop before their providers.
 *
 * The registrations stay. The container stays usable, and a later `start()` builds them again. `dispose()` clears the container.
 * Rejects with the teardown errors.
 *
 * When `options.signal` aborts, it rejects with the reason and stops waiting. The container stays stopped: a later `start()` builds again.
 * The services that did not stop yet stay in `stopping` until their cleanups settle.
 *
 * A call from the cleanup chain of the container or of a descendant cannot wait, because the stop waits for that cleanup.
 * injeca finds such a call by the signal of the cleanup, or by the synchronous part of the cleanup. It warns, sends a `reentrant-call` record, and resolves at once. The stop continues.
 */
export function stop(container: Container, options?: StopOptions): Promise<void> {
  let node: ContainerNode
  let signal: AbortSignal | undefined
  try {
    node = nodeOf(container)
    signal = readSignal(options, 'stop')
  }
  catch (error) {
    return Promise.reject(error)
  }

  const reentry = untracked(() => findReentry(node, signal))
  if (!reentry)
    return stopAndWait(node, signal)

  untracked(() => reportReentry(node, 'stop', reentry))
  stopAndWait(node, undefined).catch(() => {})
  return Promise.resolve()
}

async function stopAndWait(node: ContainerNode, signal: AbortSignal | undefined): Promise<void> {
  const containers = affectedContainers(node)
  const affected = new Set(containers)
  // The container that the caller stops leaves the start set of its parent. Its started children stay in its own start set.
  node.enrolled = false

  const errors: unknown[] = []
  const stopTeardown = node.runtime.reconciler.onTeardown((service, teardownErrors) => {
    if (service.kind !== 'resolver' && affected.has(service.container))
      errors.push(...teardownErrors)
  })

  const settled = untracked(() => {
    batch(() => {
      for (const current of containers)
        current.signals.started(false)
      for (const service of presentServices(containers)) {
        service.signals.demanded(false)
        service.signals.subscribers(new Set())
      }
    })

    const stopped = (service: ServiceNode): boolean => service.signals.instance() === undefined && !transitionalPhases.has(service.signals.phase())
    return waitUntilSettled(containers, services => services.every(stopped) ? { kind: 'done' } : 'waiting', signal, (reason) => {
      recordAbortedWait(presentServices(containers).filter(service => !stopped(service)), 'stop', reason)
      return reason
    })
  })

  try {
    await settled
  }
  finally {
    stopTeardown()
  }

  if (errors.length > 0)
    throw errorFrom(errors, 'Stop failed.')
}
