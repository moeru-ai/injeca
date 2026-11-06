import type { BuildFunction, ServiceNode } from '../graph/graph'
import type { Container, DependencyDeclarations, ResolveDependencyDeclaration } from '../types'

import { BuildAfterDisposeError, WaitTimeoutError } from '../diagnostics/errors'
import { assertActive, createService, nodeOf, readEdges, releaseService } from '../graph/nodes'
import { blockingFailure } from '../graph/resolvers/resolvers'
import { batch, untracked } from '../helpers/signals'
import { armWaitBounds, readWaitBounds } from '../helpers/wait-bounds'

export interface ResolveOptions {
  /** Rejects with the abort reason when the signal aborts. */
  signal?: AbortSignal
  /** Rejects with `wait-timeout` after this many milliseconds of the container clock. There is no default. */
  timeoutMs?: number
}

/**
 * Waits until the dependencies are available and returns their values. Before `start()`, it builds and starts them.
 *
 * Rejects when a required dependency fails. With `options.signal` or `options.timeoutMs`, it rejects on an abort or a timeout.
 * Each rejection removes the hidden resolver of the call. The values can become stale after a run-time change. Use it for one-time code.
 */
export function resolve<Deps extends DependencyDeclarations>(container: Container, dependsOn: Deps, options?: ResolveOptions): Promise<ResolveDependencyDeclaration<Deps>> {
  const node = nodeOf(container)
  assertActive(node, 'resolve')

  const edges = readEdges('resolve', dependsOn)
  const bounds = readWaitBounds(options, 'resolve')
  if (bounds.signal?.aborted)
    return Promise.reject(bounds.signal.reason)

  const { reconciler } = node.runtime

  return new Promise((done, fail) => untracked(() => {
    let settled = false
    let service: ServiceNode | undefined
    let stopListening = () => {}
    let disarm = () => {}

    const finish = (outcome: () => void): void => {
      if (settled)
        return

      settled = true
      stopListening()
      disarm()
      batch(() => releaseService(service!))
      outcome()
    }

    // The resolver reads its dependencies in `build`, then withdraws itself. It never starts.
    const build: BuildFunction = context => finish(() => done({ ...context.dependsOn } as ResolveDependencyDeclaration<Deps>))

    batch(() => {
      service = createService({ container: node, kind: 'resolver', name: 'resolve', edges, build })
      node.services.add(service)
    })

    // A required dependency that failed, directly or through a pending provider, rejects the call.
    stopListening = reconciler.onDrained(() => {
      const failure = blockingFailure(service!)
      if (failure)
        finish(() => fail(failure.error))
    })
    disarm = armWaitBounds(node.runtime.clock, bounds, () => {
      finish(() => fail(new WaitTimeoutError(`resolve() timed out after ${bounds.timeoutMs}ms.`)))
    }, reason => finish(() => fail(reason)))
    void service!.withdrawal.promise.then(() => finish(() => fail(new BuildAfterDisposeError('The container was disposed before resolve() got its dependencies.'))))
  }))
}
