import type { Clock } from './clock'

import { InvalidArgumentError, WaitTimeoutError } from '../diagnostics/errors'
import { setWeakTimeout } from './clock'
import { untracked } from './signals'
import { createWaiter, onAbort } from './waiter'

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

/** The signals that each combined signal of `anySignal` comes from. A derived signal keeps the origin of its sources. */
const parents = new WeakMap<AbortSignal, readonly AbortSignal[]>()

/**
 * Returns a signal that aborts when one of `signals` aborts, with the reason of the first one. `undefined` entries are skipped.
 *
 * It uses `AbortSignal.any` when the runtime has it. Otherwise it forwards the abort, and removes its listeners from all signals when it aborts.
 */
export function anySignal(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const sources = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (sources.length === 1)
    return sources[0]!

  let signal: AbortSignal
  if (typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any(sources)
  }
  else {
    const controller = new AbortController()
    forwardAbort(controller, sources)
    signal = controller.signal
  }
  parents.set(signal, sources)
  return signal
}

/** Lists `signal` and each signal that it comes from through `anySignal`, `withTimeout` included, nearest first. */
export function signalSources(signal: AbortSignal): AbortSignal[] {
  const seen = new Set<AbortSignal>([signal])
  const queue = [signal]
  for (let index = 0; index < queue.length; index++) {
    for (const parent of parents.get(queue[index]!) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent)
        queue.push(parent)
      }
    }
  }

  return queue
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

/**
 * Waits for `promise` until `signal` aborts. At the abort, it rejects with the result of `reasonOf`, and nothing waits for `promise` any more.
 *
 * A rejection of `promise` after the abort is not reported. The listener goes when the wait settles.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, reasonOf: (reason: unknown) => unknown = reason => reason): Promise<T> {
  if (!signal)
    return promise

  const waiter = createWaiter<T>(signal, (reason) => {
    promise.catch(() => {})
    return reasonOf(reason)
  })
  promise.then(waiter.resolve, waiter.reject)
  return waiter.promise
}

/** The result of `raceAbort`: the value of the promise, or `aborted` when the signal aborted first. */
export type RaceResult<T> = { readonly kind: 'settled', readonly value: T } | { readonly kind: 'aborted' }

/**
 * Waits for `promise` until `signal` aborts. An aborted signal gives `aborted` at once.
 *
 * A rejection of `promise` before the abort rejects the result. After the abort, nothing waits for `promise`, and its rejection is not reported.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<RaceResult<T>> {
  const waiter = createWaiter<RaceResult<T>>(undefined)
  const aborted = (): void => {
    promise.catch(() => {})
    waiter.resolve({ kind: 'aborted' })
  }
  if (signal.aborted)
    aborted()
  else
    waiter.defer(onAbort(signal, aborted))
  promise.then(value => waiter.resolve({ kind: 'settled', value }), waiter.reject)
  return waiter.promise
}
