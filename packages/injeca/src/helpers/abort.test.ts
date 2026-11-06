import { afterEach, describe, expect, it, vi } from 'vitest'

import { trackedController } from '../testing/helpers'
import { abortable, anySignal, isTimeoutReason, raceAbort } from './abort'
import { setWeakTimeout, systemClock } from './clock'

describe('anySignal', () => {
  const nativeAny = AbortSignal.any

  afterEach(() => {
    Object.defineProperty(AbortSignal, 'any', { value: nativeAny, configurable: true, writable: true })
  })

  it('aborts with the reason of the first signal that aborts, with AbortSignal.any', () => {
    const first = new AbortController()
    const second = new AbortController()
    const signal = anySignal(first.signal, undefined, second.signal)

    second.abort('second')
    first.abort('first')
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('second')
  })

  it('composes the signals without AbortSignal.any, and removes its listeners when it aborts', () => {
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true })
    const first = trackedController()
    const second = trackedController()
    const signal = anySignal(first.signal, second.signal)
    expect(first.listeners()).toBe(1)
    expect(second.listeners()).toBe(1)

    first.controller.abort('first')
    expect(signal.reason).toBe('first')
    expect(second.listeners()).toBe(0)
  })

  it('is aborted at once when one signal already aborted, without AbortSignal.any', () => {
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true })
    const live = trackedController()
    const signal = anySignal(live.signal, AbortSignal.abort('done'))

    expect(signal.reason).toBe('done')
    expect(live.listeners()).toBe(0)
  })

  it('returns the only signal as it is', () => {
    const { signal } = new AbortController()
    expect(anySignal(undefined, signal)).toBe(signal)
  })
})

describe('waits on a signal', () => {
  it('tells a timeout reason by its name', () => {
    expect(isTimeoutReason(new DOMException('late', 'TimeoutError'))).toBe(true)
    expect(isTimeoutReason({ name: 'TimeoutError' })).toBe(true)
    expect(isTimeoutReason(new DOMException('stop', 'AbortError'))).toBe(false)
    expect(isTimeoutReason('TimeoutError')).toBe(false)
  })

  it('removes the listener of raceAbort and abortable when the promise settles first', async () => {
    const { signal, listeners } = trackedController()

    await expect(raceAbort(Promise.resolve(1), signal)).resolves.toEqual({ kind: 'settled', value: 1 })
    await expect(abortable(Promise.reject(new Error('broken')), signal)).rejects.toThrow('broken')
    expect(listeners()).toBe(0)
  })

  it('settles at once for an aborted signal, and does not report a later rejection', async () => {
    const signal = AbortSignal.abort('stop')
    const late = Promise.reject(new Error('late'))

    await expect(raceAbort(late, signal)).resolves.toEqual({ kind: 'aborted' })
    await expect(abortable(late, signal, reason => `mapped ${String(reason)}`)).rejects.toBe('mapped stop')
  })
})

describe('setWeakTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('unrefs a timer of the system clock, so that it does not keep a Node process alive', () => {
    const unref = vi.fn()
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>)
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    const cancel = setWeakTimeout(systemClock, () => {}, 10)
    expect(unref).toHaveBeenCalledTimes(1)
    cancel()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('uses the setTimeout of another clock', () => {
    const cancel = vi.fn()
    const setTimeout = vi.fn(() => cancel)
    setWeakTimeout({ now: () => 0, setTimeout }, () => {}, 10)
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 10)
  })
})
