import type { Clock } from './clock'

import { anySignal, raceAbort, timeoutSignal } from './abort'

export interface DeadlineOptions {
  readonly clock: Clock
  /** `undefined` means no deadline. `reason` gives the abort reason of the deadline. */
  readonly ms: number | undefined
  readonly reason: () => unknown
  /** Other signals that the callbacks see in `signal`, for example the disposal of an instance. */
  readonly sources?: readonly AbortSignal[]
  /** Runs once, at the first timeout, after the callback in progress is abandoned. The caller warns, records, and decides here. */
  readonly onTimeout: () => void
  /** Gets the failure of an abandoned callback. A failure with the reason of `signal` or of a source does not come here, because the callback only followed its abort. */
  readonly onLateFailure: (error: unknown) => void
}

/** One deadline for a group of callbacks. At the deadline, injeca abandons them: it stops waiting, and they keep running. */
export interface Deadline {
  /** The signal for the callbacks. It aborts at the deadline or when a source aborts. `undefined` means no deadline and no source. */
  readonly signal: AbortSignal | undefined
  /**
   * Waits for `promise` until the deadline. A rejection before the deadline rejects the wait. `undefined` means that injeca abandoned `promise`.
   * Then `late` gets its value, and `onLateFailure` gets its rejection. After the deadline, `run` abandons each promise at once.
   */
  readonly run: <T>(promise: Promise<T>, late?: (value: T) => void) => Promise<{ readonly value: T } | undefined> | undefined
  /** Cancels the timer. */
  readonly end: () => void
}

export function openDeadline(options: DeadlineOptions): Deadline {
  const { ms, sources = [] } = options
  const timer = ms === undefined ? undefined : timeoutSignal(options.clock, ms, options.reason)
  const signal = sources.length > 0 || timer ? anySignal(...sources, timer?.signal) : undefined
  let expired = false

  const abandon = <T>(promise: Promise<T>, late?: (value: T) => void): undefined => {
    promise.then(value => late?.(value), (error: unknown) => {
      if (![signal, ...sources].some(source => source?.aborted && source.reason === error))
        options.onLateFailure(error)
    })
    return undefined
  }
  const wait = async <T>(promise: Promise<T>, late?: (value: T) => void): Promise<{ readonly value: T } | undefined> => {
    if (!timer)
      return { value: await promise }

    const result = await raceAbort(promise, timer.signal)
    if (result.kind === 'settled')
      return { value: result.value }

    abandon(promise, late)
    expired = true
    options.onTimeout()
    return undefined
  }

  return { signal, run: (promise, late) => expired ? abandon(promise, late) : wait(promise, late), end: () => timer?.cancel() }
}

/** The warning of a `stop` timeout. With `hint`, it tells the most common cause: a cleanup that waits for its own container. */
export function stopTimeoutWarning(subject: string, timeoutMs: number, work: 'stop' | 'disposal', hint?: { readonly action: string, readonly advice: string }): string {
  const warning = `${subject} did not settle within the stop timeout of ${timeoutMs}ms. injeca stopped waiting for them, and the ${work} continues.`
  return hint ? `${warning} The container is ${hint.action}. A cleanup can be waiting for its own container. ${hint.advice}` : warning
}
