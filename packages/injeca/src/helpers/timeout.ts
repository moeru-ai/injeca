import type { Clock } from './clock'

import { untracked } from './signals'

/** The result of `raceTimeout`: the value of the promise, or `timeout` when the time passed first. */
export type TimedResult<T> = { readonly kind: 'settled', readonly value: T } | { readonly kind: 'timeout' }

/**
 * Waits for `promise` until `ms` milliseconds of `clock` pass.
 *
 * A rejection of `promise` before the timeout rejects the result. After the timeout, nothing waits for `promise`, and its rejection is not reported.
 */
export function raceTimeout<T>(clock: Clock, promise: Promise<T>, ms: number): Promise<TimedResult<T>> {
  return new Promise((resolve, reject) => {
    let done = false
    // The timer callback is an entry point.
    const cancel = clock.setTimeout(() => untracked(() => {
      if (done)
        return

      done = true
      promise.catch(() => {})
      resolve({ kind: 'timeout' })
    }), ms)
    promise.then(
      (value) => {
        if (done)
          return

        done = true
        cancel()
        resolve({ kind: 'settled', value })
      },
      (error: unknown) => {
        if (done)
          return

        done = true
        cancel()
        reject(error)
      },
    )
  })
}
