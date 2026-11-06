import type { Logger } from '../diagnostics/logger'
import type { ServiceNode } from '../graph/graph'
import type { Container } from '../types'

import { untracked } from '../helpers/signals'

/** Calls a user callback with tracking paused. A synchronous throw becomes a rejection. */
export function invokeUser<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(untracked(fn))
  }
  catch (error) {
    return Promise.reject(error)
  }
}

/** The logger of the lifecycle trace of `container`, or `undefined` when its `logging` option is off. `warn` does not use it. */
export function traceLoggerOf(container: Container): Logger | undefined {
  return container.logging ? container.logger : undefined
}

/** Only services with a key write the lifecycle trace. Invocations and resolvers do not. */
export function loggerOf(service: ServiceNode): Logger | undefined {
  return service.kind === 'service' ? traceLoggerOf(service.container.api) : undefined
}

export function callListeners<A extends unknown[]>(listeners: ReadonlySet<(...args: A) => void>, ...args: A): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args)
    }
    catch (error) {
      // A listener error does not stop the reconciler. Report it outside the current call stack.
      queueMicrotask(() => {
        throw error
      })
    }
  }
}
