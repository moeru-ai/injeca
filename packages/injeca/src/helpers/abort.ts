import type { Clock } from './clock'

import { InvalidArgumentError, WaitTimeoutError } from '../diagnostics/errors'
import { setWeakTimeout } from './clock'
import { untracked } from './signals'

/** The reason of a timeout signal: a `DOMException` with the name `TimeoutError`, as for `AbortSignal.timeout()`. */
export function timeoutReason(message: string): DOMException {
  return new DOMException(message, 'TimeoutError')
}

/** Returns `true` when `reason` names itself a timeout: `reason.name === 'TimeoutError'`. The reason of `AbortSignal.timeout()` and of `timeout()` passes. */
export function isTimeoutReason(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { readonly name?: unknown }).name === 'TimeoutError'
}

/** The rejection of a wait for a state that `reason` aborted: `wait-timeout` with the reason as `cause` for a timeout reason, else the reason itself. */
export function waitAbortError(reason: unknown, message: string): unknown {
  return isTimeoutReason(reason) ? new WaitTimeoutError(message, { cause: reason }) : reason
}

/**
 * Aborts `controller` when one of `sources` aborts, with the reason of that source.
 * Returns a function that removes the listeners. The listeners also go when the first source aborts.
 */
export function forwardAbort(controller: AbortController, sources: readonly AbortSignal[]): () => void {
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  const release = (): void => {
    for (const [source, listener] of listeners.splice(0))
      source.removeEventListener('abort', listener)
  }

  for (const source of sources) {
    if (source.aborted) {
      release()
      controller.abort(source.reason)
      return release
    }

    const listener = (): void => {
      release()
      controller.abort(source.reason)
    }
    source.addEventListener('abort', listener, { once: true })
    listeners.push([source, listener])
  }

  return release
}

/**
 * Returns a signal that aborts when one of `signals` aborts, with the reason of the first one. `undefined` entries are skipped.
 *
 * It uses `AbortSignal.any` when the runtime has it. Otherwise it forwards the abort, and removes its listeners from all signals when it aborts.
 */
export function anySignal(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const sources = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (sources.length === 1)
    return sources[0]!
  if (typeof AbortSignal.any === 'function')
    return AbortSignal.any(sources)

  const controller = new AbortController()
  forwardAbort(controller, sources)
  return controller.signal
}

/** A signal that aborts after `ms` of `clock`. `cancel` stops the timer, and the signal then never aborts. */
export interface TimeoutSignal {
  readonly signal: AbortSignal
  readonly cancel: () => void
}

/**
 * Creates a signal that aborts after `ms` milliseconds of `clock`, with the result of `reason`.
 *
 * With `weak` and the system clock, the timer does not keep a Node process alive, as for `AbortSignal.timeout()`.
 */
export function timeoutSignal(clock: Clock, ms: number, reason: () => unknown, weak = false): TimeoutSignal {
  const controller = new AbortController()
  // The timer callback is an entry point.
  const abort = (): void => untracked(() => controller.abort(reason()))
  const cancel = weak ? setWeakTimeout(clock, abort, ms) : clock.setTimeout(abort, ms)

  return { signal: controller.signal, cancel }
}

/** Reads and checks the `signal` option of `options` once. `action` names the call in errors. */
export function readSignal(options: { readonly signal?: unknown } | undefined, action: string): AbortSignal | undefined {
  let signal: unknown
  try {
    signal = options?.signal
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the ${action} options.`, { cause: error })
  }
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new InvalidArgumentError(`The signal option of ${action} must be an AbortSignal.`)

  return signal
}

/** Calls `callback` with the reason when `signal` aborts. Returns a function that removes the listener. The callback is an entry point, so it runs untracked. */
export function onAbort(signal: AbortSignal | undefined, callback: (reason: unknown) => void): () => void {
  if (!signal)
    return () => {}

  const listener = (): void => untracked(() => callback(signal.reason))
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

/**
 * Waits for `promise` until `signal` aborts. At the abort, it rejects with the result of `reasonOf`, and nothing waits for `promise` any more.
 *
 * A rejection of `promise` after the abort is not reported. The listener goes when the wait settles.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, reasonOf: (reason: unknown) => unknown = reason => reason): Promise<T> {
  if (!signal)
    return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(reasonOf(signal.reason))
  }

  return new Promise<T>((resolve, reject) => {
    const remove = onAbort(signal, (reason) => {
      promise.catch(() => {})
      reject(reasonOf(reason))
    })
    promise.then(
      (value) => {
        remove()
        resolve(value)
      },
      (error: unknown) => {
        remove()
        reject(error)
      },
    )
  })
}

/** The result of `raceAbort`: the value of the promise, or `aborted` when the signal aborted first. */
export type RaceResult<T> = { readonly kind: 'settled', readonly value: T } | { readonly kind: 'aborted' }

/**
 * Waits for `promise` until `signal` aborts. An aborted signal gives `aborted` at once.
 *
 * A rejection of `promise` before the abort rejects the result. After the abort, nothing waits for `promise`, and its rejection is not reported.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<RaceResult<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {})
      resolve({ kind: 'aborted' })
      return
    }

    const remove = onAbort(signal, () => {
      promise.catch(() => {})
      resolve({ kind: 'aborted' })
    })
    promise.then(
      (value) => {
        remove()
        resolve({ kind: 'settled', value })
      },
      (error: unknown) => {
        remove()
        reject(error)
      },
    )
  })
}
