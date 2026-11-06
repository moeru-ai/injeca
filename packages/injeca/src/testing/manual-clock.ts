import type { Clock } from '../helpers/clock'

/** A clock that moves only when a test calls `advance`. Pass `clock` to `createContainer`. */
export interface ManualClock {
  /** The clock for `createContainer({ clock })`. Its time starts at 0. */
  readonly clock: Clock
  /**
   * Moves the time forward by `ms`, and runs each timer that is due, in the order of its time.
   * A timer that a callback sets during the call runs at a later call, also when it is due now.
   */
  readonly advance: (ms: number) => void
  /** The number of timers that wait. A timer that was cancelled or that ran does not count. */
  readonly pending: () => number
}

/**
 * Creates a manual clock for tests. It drives `timeout()`, `withTimeout()`, requeue delays, and the `start` and `stop` policy timeouts without real time.
 *
 * `advance` runs the timer callbacks synchronously. Await `drained(container)` after it, so that the work that the callbacks start settles.
 */
export function manualClock(): ManualClock {
  let now = 0
  let seq = 0
  const timers = new Map<number, { readonly at: number, readonly callback: () => void }>()

  return {
    clock: {
      now: () => now,
      setTimeout: (callback, ms) => {
        const id = ++seq
        timers.set(id, { at: now + ms, callback })
        return () => timers.delete(id)
      },
    },
    advance: (ms) => {
      now += ms
      const due = [...timers].filter(([, timer]) => timer.at <= now).sort(([, a], [, b]) => a.at - b.at)
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.callback()
      }
    },
    pending: () => timers.size,
  }
}
