import type { ServiceNode } from '../graph/graph'

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

/** Only services with a key write to the logger. Invocations and resolvers do not. */
export function loggerOf(service: ServiceNode) {
  return service.kind === 'service' ? service.container.api.logger : undefined
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
