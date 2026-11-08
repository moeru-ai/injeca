import { describe, expect, it, vi } from 'vitest'

import { trackedController } from '../testing/helpers'
import { createWaiter } from './waiter'

describe('createWaiter', () => {
  it('settles once, and runs the removers before it settles', async () => {
    const order: string[] = []
    const waiter = createWaiter<number>(undefined)
    waiter.defer(() => order.push('remove'))
    waiter.promise.then(() => order.push('settled'), () => {})

    waiter.resolve(1)
    waiter.reject(new Error('ignored'))
    await expect(waiter.promise).resolves.toBe(1)
    expect(order).toEqual(['remove', 'settled'])
    expect(waiter.settled()).toBe(true)
  })

  it('runs a remover at once after it settled', () => {
    const waiter = createWaiter<void>(undefined)
    waiter.resolve()
    const remove = vi.fn()
    waiter.defer(remove)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects with the mapped reason when the signal aborts, and removes its listener when it settles', async () => {
    const tracked = trackedController()
    const waiter = createWaiter<void>(tracked.signal, reason => `mapped ${String(reason)}`)
    expect(tracked.listeners()).toBe(1)

    tracked.controller.abort('stop')
    await expect(waiter.promise).rejects.toBe('mapped stop')
    expect(tracked.listeners()).toBe(0)
  })

  it('rejects at once for an aborted signal', async () => {
    const waiter = createWaiter<void>(AbortSignal.abort('gone'))
    expect(waiter.settled()).toBe(true)
    await expect(waiter.promise).rejects.toBe('gone')
  })
})
