import type { Container, ContainerOptions, ObserveRecord, PolicyOptions } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { createContainer, dispose, provide, start, stop } from '../scoped'
import { collectRecords, deferred, drained, manualClock, stateOf } from '../testing/helpers'

async function tick(manual: { advance: (ms: number) => void }, app: Container, ms: number): Promise<void> {
  manual.advance(ms)
  await drained(app)
}

/** Provides `airi.server` with a `start` hook that waits for `gate`, and a second hook that records its call. */
function setup(options: { container?: Omit<ContainerOptions, 'clock'>, service?: PolicyOptions } = {}) {
  const manual = manualClock()
  const app = createContainer({ enabled: false, ...options.container, clock: manual.clock })
  const gate = deferred()
  const signals: AbortSignal[] = []
  const later = vi.fn()
  const stopHook = vi.fn()
  provide(app, 'airi.server', {
    ...options.service,
    build: ({ on }) => {
      on('start', ({ signal }) => {
        signals.push(signal)
        return gate.promise
      })
      on('start', later)
      on('stop', stopHook)
      return 'server'
    },
  })
  const { records } = collectRecords(app)

  return { ...manual, app, gate, signals, later, stopHook, records }
}

function timeoutRecords(records: readonly ObserveRecord[]) {
  return records.filter(record => record.type === 'timeout')
}

describe('start timeouts', () => {
  it('aborts the run signal with hook-timeout at the timeout, and cancels the timer when the start settles first', async () => {
    const timedOut = setup({ service: { timeouts: { start: 100 } } })
    void start(timedOut.app).catch(() => {})
    await drained(timedOut.app)
    await tick(timedOut, timedOut.app, 100)
    expect(timedOut.signals[0]?.reason).toMatchObject({ code: 'hook-timeout', hook: 'start', timeoutMs: 100 })

    const settled = setup({ service: { timeouts: { start: 100 } } })
    const started = start(settled.app)
    await drained(settled.app)
    expect(settled.pending()).toBe(1)
    settled.gate.resolve()
    await started
    expect(settled.pending()).toBe(0)
    expect(settled.signals[0]?.aborted).toBe(false)
  })

  // Design test 20.
  it('waits until start settles when no timeout is configured', async () => {
    const ctx = setup()
    const started = start(ctx.app)
    await drained(ctx.app)
    await tick(ctx, ctx.app, 1_000_000)
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('starting')
    expect(ctx.pending()).toBe(0)

    ctx.gate.resolve()
    await started
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('running')
    expect(timeoutRecords(ctx.records)).toEqual([])
  })

  it('records the timeout, aborts the run, and fails with hook-timeout without onTimeout', async () => {
    const ctx = setup({ service: { timeouts: { start: 100 } } })
    const started = start(ctx.app)
    const rejection = expect(started).rejects.toMatchObject({ code: 'hook-timeout', hook: 'start', timeoutMs: 100 })
    await drained(ctx.app)
    await tick(ctx, ctx.app, 99)
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('starting')

    await tick(ctx, ctx.app, 1)
    await rejection
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('failed')
    expect(ctx.signals[0]?.aborted).toBe(true)
    expect(timeoutRecords(ctx.records)).toEqual([expect.objectContaining({ key: 'airi.server', hook: 'start', timeoutMs: 100, attempt: 1 })])
    expect(ctx.records).toContainEqual(expect.objectContaining({ type: 'decision', hook: 'start', decision: 'fail', ignored: false }))
    expect(ctx.stopHook).toHaveBeenCalledTimes(1)

    // The late start does not run the later handlers.
    ctx.gate.resolve()
    await drained(ctx.app)
    expect(ctx.later).not.toHaveBeenCalled()
  })

  it('applies the onTimeout decision: a requeue retries the start', async () => {
    const onTimeout = vi.fn(context => context.hook === 'start' ? context.decide.requeue({ after: 50, reason: 'slow device' }) : undefined)
    const ctx = setup({ service: { timeouts: { start: 100 }, onTimeout } })
    void start(ctx.app)
    await drained(ctx.app)
    await tick(ctx, ctx.app, 100)

    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ hook: 'start', timeoutMs: 100, attempt: 1 }))
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('retrying')
    await tick(ctx, ctx.app, 50)
    expect(ctx.signals).toHaveLength(2)
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('starting')
  })

  it('gives fail when onTimeout returns a value that is not a decision', async () => {
    const ctx = setup({ service: { timeouts: { start: 10 }, onTimeout: () => 'later' } })
    const rejection = expect(start(ctx.app)).rejects.toMatchObject({ code: 'hook-timeout' })
    await drained(ctx.app)
    await tick(ctx, ctx.app, 10)
    await rejection
  })

  it('uses the service timeout over the container timeout, and the container onTimeout without a service one', async () => {
    const onTimeout = vi.fn(context => context.decide.fail(new Error('container policy')))
    const ctx = setup({ container: { timeouts: { start: 50 }, onTimeout }, service: { timeouts: { start: 200 } } })
    const rejection = expect(start(ctx.app)).rejects.toThrow('container policy')
    await drained(ctx.app)
    await tick(ctx, ctx.app, 50)
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('starting')

    await tick(ctx, ctx.app, 150)
    await rejection
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('uses the container timeout when the service has none, and the service onTimeout over the container one', async () => {
    const containerHandler = vi.fn()
    const ctx = setup({ container: { timeouts: { start: 50 }, onTimeout: containerHandler }, service: { onTimeout: context => context.decide.fail(new Error('service policy')) } })
    const rejection = expect(start(ctx.app)).rejects.toThrow('service policy')
    await drained(ctx.app)
    await tick(ctx, ctx.app, 50)
    await rejection
    expect(containerHandler).not.toHaveBeenCalled()
  })

  it('rejects a timeout that is not a finite number of 0 or more', () => {
    const app = createContainer({ enabled: false })
    expect(() => provide(app, 'airi.bad', { timeouts: { start: -1 }, build: () => 1 })).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
    expect(() => createContainer({ enabled: false, timeouts: { stop: Number.NaN } })).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
  })
})

describe('a start hook that stop() or dispose() aborts (G2)', () => {
  it('does not wait for the start hook. The stop hooks run at once, and the late decision is ignored', async () => {
    const ctx = setup()
    void start(ctx.app)
    await drained(ctx.app)
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('starting')

    // The gate never opens before the disposal settles.
    await dispose(ctx.app)
    expect(ctx.signals[0]?.aborted).toBe(true)
    expect(ctx.stopHook).toHaveBeenCalledTimes(1)
    expect(ctx.later).not.toHaveBeenCalled()

    ctx.gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.later).not.toHaveBeenCalled()
  })

  it('lets stop() settle without the start hook, and a later start() builds again', async () => {
    const ctx = setup()
    void start(ctx.app)
    await drained(ctx.app)

    await stop(ctx.app)
    expect(ctx.stopHook).toHaveBeenCalledTimes(1)
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('pending')

    const restarted = start(ctx.app)
    await drained(ctx.app)
    expect(ctx.signals).toHaveLength(2)
    ctx.gate.resolve()
    await drained(ctx.app)
    // The decision of the first run arrives late. It is ignored.
    expect(ctx.records).toContainEqual(expect.objectContaining({ type: 'decision', hook: 'start', decision: 'handled', ignored: true }))
    await restarted
    expect(stateOf(ctx.app, 'airi.server').phase).toBe('running')
  })

  it('still applies a configured stop timeout to the stop hooks', async () => {
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock, timeouts: { stop: 100 } })
    provide(app, 'airi.server', ({ on }) => {
      on('start', () => new Promise(() => {}))
      on('stop', () => new Promise(() => {}))
      return 'server'
    })
    void start(app)
    await drained(app)

    const { records } = collectRecords(app)
    const disposal = dispose(app)
    await drained(app)
    manual.advance(100)
    await expect(disposal).resolves.toBeUndefined()
    expect(records).toContainEqual(expect.objectContaining({ type: 'timeout', key: 'airi.server', hook: 'stop', timeoutMs: 100 }))
  })
})
