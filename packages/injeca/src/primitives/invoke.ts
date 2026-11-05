import type { BuildFunction, ServiceNode } from '../graph/graph'
import type { Container, DependencyDeclarations, DependencyMap, InvocationHandle, InvokeOption, InvokeOptionWithKeys } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { assertActive, createService, nodeOf, readEdges, withdrawService } from '../graph/nodes'
import { batch, untracked } from '../helpers/signals'

/** The loose shape of all invoke forms. The overloads check the types. */
export type InvokeAnyOption = ((dependencies: never, context: never) => unknown) | { callback: (dependencies: never, context: never) => unknown, dependsOn?: unknown }

/**
 * Registers an invocation: a service without a value. The callback runs when the required dependencies are available.
 * Before `start()`, it waits for `start()`.
 */
export function invoke<Deps extends DependencyDeclarations>(container: Container, option: InvokeOptionWithKeys<Deps>): InvocationHandle
export function invoke<D extends DependencyMap>(container: Container, option: InvokeOption<D>): InvocationHandle
export function invoke(container: Container, option: InvokeAnyOption): InvocationHandle {
  return invokeIn(container, option)
}

/** Registers an invocation. The public `invoke` functions call it. */
export function invokeIn(container: Container, option: InvokeAnyOption): InvocationHandle {
  const node = nodeOf(container)
  assertActive(node, 'invoke')

  let callback: unknown
  let dependsOn: unknown
  try {
    const invocationObject: { callback?: unknown, dependsOn?: unknown } = typeof option === 'function' ? { callback: option } : option
    callback = invocationObject.callback
    dependsOn = invocationObject.dependsOn
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the invoke options.', { cause: error })
  }
  if (typeof callback !== 'function')
    throw new InvalidArgumentError('The callback option of invoke is not a function.')

  const name = `invocation:${node.runtime.nextSeq()}`
  const edges = readEdges(name, dependsOn)
  const userCallback = callback as (dependencies: unknown, context: unknown) => unknown
  const build: BuildFunction = context => userCallback(context.dependsOn, Object.freeze({ on: context.on, effect: context.effect, signal: context.signal }))

  const registered = untracked(() => {
    let service: ServiceNode | undefined
    batch(() => {
      service = createService({ container: node, kind: 'invocation', name, edges, build })
      node.services.add(service)
    })

    return service!
  })

  container.logger.invoke(edges.map(edge => edge.keyName))

  return Object.freeze({ withdraw: () => withdrawService(registered) })
}
