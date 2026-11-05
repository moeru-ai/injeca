import type { BuildFunction, ServiceNode } from '../graph/graph'
import type { Container, DependencyDeclarations, ResolveDependencyDeclaration } from '../types'

import { BuildAfterDisposeError } from '../diagnostics/errors'
import { assertActive, createService, nodeOf, readEdges, releaseService } from '../graph/nodes'
import { blockingFailure } from '../graph/resolvers/resolvers'
import { batch, untracked } from '../helpers/signals'

/**
 * Waits until the dependencies are available and returns their values. Before `start()`, it builds and starts them.
 *
 * Rejects when a required dependency fails. The values can become stale after a run-time change. Use it for one-time code.
 */
export function resolve<Deps extends DependencyDeclarations>(container: Container, dependsOn: Deps): Promise<ResolveDependencyDeclaration<Deps>> {
  const node = nodeOf(container)
  assertActive(node, 'resolve')

  const edges = readEdges('resolve', dependsOn)
  const { reconciler } = node.runtime

  return new Promise((done, fail) => untracked(() => {
    let settled = false
    let service: ServiceNode | undefined
    let stopListening = () => {}

    const finish = (outcome: () => void): void => {
      if (settled)
        return

      settled = true
      stopListening()
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
    void service!.withdrawal.promise.then(() => finish(() => fail(new BuildAfterDisposeError('The container was disposed before resolve() got its dependencies.'))))
  }))
}
