import type { ContainerNode, ServiceNode } from '../graph/graph'
import type { Container } from '../types'

import { InvalidArgumentError, StartTimeoutError } from '../diagnostics/errors'
import { describeExplanations, explainService } from '../diagnostics/explain'
import { affectedContainers, assertActive, nodeOf, setPhase } from '../graph/nodes'
import { errorFrom } from '../helpers/error-from'
import { batch, untracked } from '../helpers/signals'

const visibleKinds: ReadonlySet<ServiceNode['kind']> = new Set(['service', 'invocation'])

const transitionalPhases: ReadonlySet<string> = new Set(['building', 'starting', 'stopping'])

/** The result of one settle check. `'waiting'` checks again at the next drain. */
type SettleCheck = 'waiting' | { readonly kind: 'done' } | { readonly kind: 'failed', readonly errors: readonly unknown[] }

/** Lists the present services and invocations of `containers`. */
function presentServices(containers: readonly ContainerNode[]): ServiceNode[] {
  return containers.flatMap(container => [...container.services].filter(service => visibleKinds.has(service.kind) && service.signals.present()))
}

/**
 * Runs `check` each time the work queue drains, until the result is not `'waiting'`.
 * With `timeoutMs`, it rejects with `start-timeout` and the explanation of each service that is not `running`.
 */
function waitUntilSettled(containers: readonly ContainerNode[], check: (services: readonly ServiceNode[]) => SettleCheck, timeoutMs?: number): Promise<void> {
  const { clock, reconciler } = containers[0]!.runtime

  return new Promise((done, fail) => {
    let cancelTimeout = () => {}
    const stopListening = reconciler.onDrained(() => {
      const result = check(presentServices(containers))
      if (result === 'waiting')
        return

      stopListening()
      cancelTimeout()
      if (result.kind === 'done')
        done()
      else
        fail(errorFrom(result.errors, 'Start failed.'))
    })

    if (timeoutMs !== undefined) {
      // The timer callback is an entry point.
      cancelTimeout = clock.setTimeout(() => untracked(() => {
        stopListening()
        const explanations = presentServices(containers).filter(service => service.signals.phase() !== 'running').map(explainService)
        fail(new StartTimeoutError(`start() timed out after ${timeoutMs}ms. These services are not running:\n${describeExplanations(explanations)}`, explanations))
      }), timeoutMs)
    }
    reconciler.requestDrain()
  })
}

export interface StartOptions {
  /** Rejects with `start-timeout` when not every service runs after this many milliseconds. There is no default. */
  timeoutMs?: number
}

function readTimeout(options: StartOptions | undefined): number | undefined {
  let timeoutMs: unknown
  try {
    timeoutMs = options?.timeoutMs
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the start options.', { cause: error })
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new InvalidArgumentError(`The timeoutMs option of start must be a finite number of 0 or more. Got ${String(timeoutMs)}.`)

  return timeoutMs
}

/**
 * Begins convergence of the container and of each child container that was started.
 *
 * Resolves when all their services and invocations are `running`. Rejects with the build and start errors.
 * A service in `failed` tries again. A required key without a provider keeps the promise pending, unless `timeoutMs` is set.
 * A child container that was never started does not start. Call `start(child)` for it.
 */
export function start(container: Container, options?: StartOptions): Promise<void> {
  const node = nodeOf(container)
  assertActive(node, 'start')
  const timeoutMs = readTimeout(options)

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
    }, timeoutMs)
  })

  return settled.then(() => container.logger.running())
}

/**
 * Stops all instances of the container and of each child container that was started. Dependents stop before their providers.
 *
 * The registrations stay. The container stays usable, and a later `start()` builds them again. `dispose()` clears the container.
 * Rejects with the teardown errors.
 */
export async function stop(container: Container): Promise<void> {
  const node = nodeOf(container)
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
      for (const service of presentServices(containers))
        service.signals.demanded(false)
    })

    return waitUntilSettled(containers, services => services.every(service => service.signals.instance() === undefined && !transitionalPhases.has(service.signals.phase()))
      ? { kind: 'done' }
      : 'waiting')
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
