import { untracked } from './signals'

/** One callback call in the queue. An error from `run` goes to `onError`. */
export interface Delivery {
  readonly run: () => void
  readonly onError: (error: unknown) => void
}

/**
 * Runs callback calls in FIFO order.
 *
 * A delivery that a callback causes does not run inside that callback. It waits in the queue. So the deliveries of one source arrive in order.
 */
export interface DeliveryQueue {
  /** Runs `deliveries` in order, after the deliveries that are already in the queue. */
  readonly deliver: (deliveries: readonly Delivery[]) => void
}

export function createDeliveryQueue(): DeliveryQueue {
  const queue: Delivery[] = []
  let draining = false

  function deliver(deliveries: readonly Delivery[]): void {
    queue.push(...deliveries)
    if (draining)
      return

    draining = true
    try {
      // Each delivery calls a user callback. It is an entry point.
      while (queue.length > 0) {
        const { run, onError } = queue.shift()!
        untracked(() => {
          try {
            run()
          }
          catch (error) {
            onError(error)
          }
        })
      }
    }
    finally {
      draining = false
    }
  }

  return { deliver }
}
