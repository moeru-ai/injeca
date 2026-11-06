import type { Container } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { nodeOf } from '../graph/nodes'
import { anySignal, readSignal, timeoutReason, timeoutSignal } from '../helpers/abort'

function readMilliseconds(ms: unknown, action: string): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
    throw new InvalidArgumentError(`The milliseconds of ${action} must be a finite number of 0 or more. Got ${String(ms)}.`)

  return ms
}

/**
 * Returns a signal that aborts after `ms` milliseconds of the clock of `container`.
 *
 * The reason is a `DOMException` with the name `TimeoutError`, as for `AbortSignal.timeout()`. Use it in place of `AbortSignal.timeout()`, because that one does not use the container clock.
 * With the system clock, the timer does not keep a Node process alive.
 */
export function timeout(container: Container, ms: number): AbortSignal {
  const { clock } = nodeOf(container).runtime
  const milliseconds = readMilliseconds(ms, 'timeout')

  return timeoutSignal(clock, milliseconds, () => timeoutReason(`The operation timed out after ${milliseconds}ms.`), true).signal
}

/** Returns a signal that aborts when `signal` aborts, or after `ms` milliseconds of the clock of `container`. Without `signal`, it is `timeout(container, ms)`. */
export function withTimeout(signal: AbortSignal | undefined, ms: number, container: Container): AbortSignal {
  const source = readSignal({ signal }, 'withTimeout')
  return anySignal(source, timeout(container, ms))
}
