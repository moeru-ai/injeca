/**
 * The time source of a container. Pass a custom clock to control time in tests.
 *
 * The reconciler uses it for requeue delays and hook timeouts. The work queue does not use it. It drains on microtasks.
 */
export interface Clock {
  now: () => number
  /** Calls `callback` after `ms` milliseconds. Returns a function that cancels the call. */
  setTimeout: (callback: () => void, ms: number) => () => void
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => {
    const handle = globalThis.setTimeout(callback, ms)
    return () => globalThis.clearTimeout(handle)
  },
})
