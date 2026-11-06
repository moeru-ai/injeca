import { describe, expect, it } from 'vitest'

import { InvalidArgumentError } from '../diagnostics/errors'
import { timeout, withTimeout } from '../scoped'
import { createTestContainer, manualClock } from '../testing/helpers'

describe('timeout', () => {
  it('aborts after the time of the container clock, with a TimeoutError DOMException', () => {
    const { clock, advance, pending } = manualClock()
    const app = createTestContainer({ clock })
    const signal = timeout(app, 50)

    advance(49)
    expect(signal.aborted).toBe(false)
    advance(1)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBeInstanceOf(DOMException)
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
    expect(pending()).toBe(0)
  })

  it('rejects a time that is not a finite number of 0 or more', () => {
    const app = createTestContainer()
    expect(() => timeout(app, -1)).toThrow(InvalidArgumentError)
    expect(() => timeout(app, Number.NaN)).toThrow(InvalidArgumentError)
    expect(() => timeout(app, Number.POSITIVE_INFINITY)).toThrow(InvalidArgumentError)
  })
})

describe('withTimeout', () => {
  it('aborts with the reason of the signal, or with the timeout', () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock })

    const controller = new AbortController()
    const cancelled = withTimeout(controller.signal, 50, app)
    controller.abort('cancelled')
    expect(cancelled.reason).toBe('cancelled')

    const timed = withTimeout(new AbortController().signal, 50, app)
    const alone = withTimeout(undefined, 50, app)
    advance(50)
    expect(timed.reason).toMatchObject({ name: 'TimeoutError' })
    expect(alone.reason).toMatchObject({ name: 'TimeoutError' })
  })

  it('rejects a signal that is not an AbortSignal', () => {
    expect(() => withTimeout('soon' as unknown as AbortSignal, 50, createTestContainer())).toThrow(InvalidArgumentError)
  })
})
