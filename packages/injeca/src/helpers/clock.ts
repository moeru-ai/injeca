/**
 * The time source of a container. Pass a custom clock to control time in tests.
 *
 * The reconciler uses it for requeue delays and hook timeouts, and `timeout()` uses it for its signal. The work queue does not use it. It drains on microtasks.
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

/**
 * Calls `callback` after `ms` milliseconds of `clock`, like `clock.setTimeout`. Returns a function that cancels the call.
 *
 * With `systemClock`, the timer does not keep a Node process alive, as for `AbortSignal.timeout()`. Other clocks get a plain `setTimeout` call.
 */
export function setWeakTimeout(clock: Clock, callback: () => void, ms: number): () => void {
  if (clock !== systemClock)
    return clock.setTimeout(callback, ms)

  const handle: unknown = globalThis.setTimeout(callback, ms)
  // NOTICE:
  // A timer of `timeout()` must not keep a Node process alive, because the caller cannot cancel it when its wait ends early.
  // Node and Bun return a timer object with `unref()`. Browsers return a number. The library has no Node types, so the check is structural.
  // Source: the timer of `AbortSignal.timeout()` is unref'd in Node (https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay).
  // Remove when `Clock` gets its own option for timers that do not keep the process alive.
  if (typeof handle === 'object' && handle !== null && typeof (handle as { readonly unref?: unknown }).unref === 'function')
    (handle as { readonly unref: () => void }).unref()

  return () => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0])
}
