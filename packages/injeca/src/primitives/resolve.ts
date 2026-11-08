import type { BuildFunction, UnitNode } from '../graph/graph'
import type { Container, DependencyDeclarations, ResolveDependencyDeclaration } from '../types'

import { BuildAfterDisposeError } from '../diagnostics/errors'
import { assertActive, createUnit, nodeOf, readEdges, releaseUnit } from '../graph/nodes'
import { blockingFailure } from '../graph/resolvers/resolvers'
import { readSignal, waitAbortError } from '../helpers/abort'
import { batch, untracked } from '../helpers/signals'
import { createWaiter } from '../helpers/waiter'

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
  const waiter = createWaiter<ResolveDependencyDeclaration<Deps>>(signal, reason => waitAbortError(reason, 'resolve() timed out.'))
  if (waiter.settled())
    return waiter.promise

  const { reconciler } = node.runtime
  untracked(() => {
    let unit: UnitNode | undefined
    // The resolver reads its dependencies in `build`, then withdraws itself. It never starts.
    const build: BuildFunction = context => waiter.resolve({ ...context.dependsOn } as ResolveDependencyDeclaration<Deps>)

    batch(() => {
      unit = createUnit({ container: node, kind: 'resolver', name: 'resolve', edges, build })
      node.units.add(unit)
    })

    // A required dependency that failed, directly or through a pending provider, rejects the call.
    waiter.defer(reconciler.onDrained(() => {
      const failure = blockingFailure(unit!)
      if (failure)
        waiter.reject(failure.error)
    }))
    waiter.defer(() => batch(() => releaseUnit(unit!)))
    void unit!.withdrawal.promise.then(() => waiter.reject(new BuildAfterDisposeError('The container was disposed before resolve() got its dependencies.')))
  })

  return waiter.promise
}
