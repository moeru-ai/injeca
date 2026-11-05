import type { Clock } from './clock'

import { InvalidArgumentError } from '../diagnostics/errors'
import { untracked } from './signals'

/** The bounds of a wait: a timeout on the container clock, and an abort signal. Neither has a default. */
export interface WaitBounds {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Reads and checks `timeoutMs` and `signal` of `options` once. `action` names the call in errors. */
export function readWaitBounds(options: { readonly timeoutMs?: unknown, readonly signal?: unknown } | undefined, action: string): WaitBounds {
  let timeoutMs: unknown
  let signal: unknown
  try {
    timeoutMs = options?.timeoutMs
    signal = options?.signal
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the ${action} options.`, { cause: error })
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new InvalidArgumentError(`The timeoutMs option of ${action} must be a finite number of 0 or more. Got ${String(timeoutMs)}.`)
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new InvalidArgumentError(`The signal option of ${action} must be an AbortSignal.`)

  return { timeoutMs: timeoutMs as number | undefined, signal: signal as AbortSignal | undefined }
}

/**
 * Calls `onTimeout` after `bounds.timeoutMs`, or `onAbort` with the abort reason when `bounds.signal` aborts.
 * Returns a function that removes both. The callbacks are entry points, so they run untracked.
 */
export function armWaitBounds(clock: Clock, bounds: WaitBounds, onTimeout: () => void, onAbort: (reason: unknown) => void): () => void {
  const { signal, timeoutMs } = bounds
  const abort = (): void => untracked(() => onAbort(signal?.reason))
  signal?.addEventListener('abort', abort, { once: true })
  const cancelTimeout = timeoutMs === undefined ? () => {} : clock.setTimeout(() => untracked(onTimeout), timeoutMs)

  return () => {
    signal?.removeEventListener('abort', abort)
    cancelTimeout()
  }
}
