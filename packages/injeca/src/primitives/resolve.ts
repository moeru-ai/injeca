import type { BuildFunction, ServiceNode } from '../graph/graph'
import type { Container, DependencyDeclarations, ResolveDependencyDeclaration } from '../types'

import { BuildAfterDisposeError } from '../diagnostics/errors'
import { assertActive, createService, nodeOf, readEdges, releaseService } from '../graph/nodes'
import { blockingFailure } from '../graph/resolvers/resolvers'
import { onAbort, readSignal, waitAbortError } from '../helpers/abort'
import { batch, untracked } from '../helpers/signals'

export interface ResolveOptions {
  /**
   * Ends the wait when the signal aborts. A timeout reason (`name === 'TimeoutError'`) rejects with `wait-timeout`, with the reason as `cause`.
   * Another reason rejects as it is. Use `timeout(container, ms)` for a timeout on the container clock. There is no default.
   */
  signal?: AbortSignal
}

/**
 * Waits until the dependencies are available and returns their values. Before `start()`, it builds and starts them.
 *
 * Rejects when a required dependency fails. With `options.signal`, it rejects when the signal aborts. An aborted signal rejects at once.
 * Each rejection removes the hidden resolver of the call. The values can become stale after a run-time change. Use it for one-time code.
 */
export function resolve<Deps extends DependencyDeclarations>(container: Container, dependsOn: Deps, options?: ResolveOptions): Promise<ResolveDependencyDeclaration<Deps>> {
  const node = nodeOf(container)
  assertActive(node, 'resolve')

  const edges = readEdges('resolve', dependsOn)
  const signal = readSignal(options, 'resolve')
  if (signal?.aborted)
    return Promise.reject(waitAbortError(signal.reason, 'resolve() timed out.'))

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
    disarm = onAbort(signal, reason => finish(() => fail(waitAbortError(reason, 'resolve() timed out.'))))
    void service!.withdrawal.promise.then(() => finish(() => fail(new BuildAfterDisposeError('The container was disposed before resolve() got its dependencies.'))))
  }))
}
