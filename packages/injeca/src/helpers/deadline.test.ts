import { describe, expect, it, vi } from 'vitest'

import { manualClock } from '../testing/manual-clock'
import { openDeadline } from './deadline'

function never<T>(): { readonly promise: Promise<T>, readonly resolve: (value: T) => void, readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('openDeadline', () => {
  it('waits without a deadline, and has no signal without a source', async () => {
    const deadline = openDeadline({ clock: manualClock().clock, ms: undefined, reason: () => 'late', onTimeout: () => {}, onLateFailure: () => {} })
    expect(deadline.signal).toBeUndefined()
    await expect(deadline.run(Promise.resolve(1))).resolves.toEqual({ value: 1 })
    await expect(deadline.run(Promise.reject(new Error('broken')))).rejects.toThrow('broken')
  })

  it('abandons the callback at the deadline, calls onTimeout once, and abandons later callbacks at once', async () => {
    const { clock, advance, pending } = manualClock()
    const onTimeout = vi.fn()
    const onLateFailure = vi.fn()
    const deadline = openDeadline({ clock, ms: 10, reason: () => 'late', onTimeout, onLateFailure })
    const slow = never<number>()
    const late = vi.fn()

    const waiting = deadline.run(slow.promise, late)
    advance(10)
    await expect(waiting).resolves.toBeUndefined()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(deadline.signal?.reason).toBe('late')

    const next = never<number>()
    expect(deadline.run(next.promise)).toBeUndefined()
    expect(onTimeout).toHaveBeenCalledTimes(1)

    slow.resolve(2)
    next.reject(new Error('broken'))
    await Promise.resolve()
    await Promise.resolve()
    expect(late).toHaveBeenCalledWith(2)
    expect(onLateFailure).toHaveBeenCalledWith(new Error('broken'))
    deadline.end()
    expect(pending()).toBe(0)
  })

  it('does not report a late failure with the reason of its signal or of a source', async () => {
    const { clock, advance } = manualClock()
    const source = new AbortController()
    const onLateFailure = vi.fn()
    const deadline = openDeadline({ clock, ms: 10, reason: () => 'late', sources: [source.signal], onTimeout: () => {}, onLateFailure })
    const first = never<void>()
    const second = never<void>()

    const waiting = deadline.run(first.promise)
    advance(10)
    await waiting
    deadline.run(second.promise)
    source.abort('disposed')
    first.reject(deadline.signal!.reason)
    second.reject('disposed')
    await Promise.resolve()
    await Promise.resolve()
    expect(onLateFailure).not.toHaveBeenCalled()
  })
})
