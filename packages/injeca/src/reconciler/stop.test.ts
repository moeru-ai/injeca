import { describe, expect, it, vi } from 'vitest'

import { createContainer, dispose, provide, start, stop } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, stateOf } from '../testing/helpers'

describe('serial transitions', () => {
  // Design test 6.
  it('builds the service again after its stop ends when the dependency returns during the stop', async () => {
    const app = createTestContainer()
    const stopGate = deferred()
    const seen: string[] = []

    const llm = provide(app, 'airi.llm', () => 'llm 1')
    provide(app, 'voice.speech', {
      dependsOn: { llm: 'airi.llm' },
      build: ({ dependsOn, on }) => {
        seen.push(dependsOn.llm as string)
        if (seen.length === 1)
          on('stop', () => stopGate.promise)
        return 'speech'
      },
    })
    await start(app)

    const withdrawal = llm.withdraw()
    await drained(app)
    expect(stateOf(app, 'voice.speech').phase).toBe('stopping')

    provide(app, 'airi.llm', () => 'llm 2')
    await drained(app)
    expect(stateOf(app, 'airi.llm').phase).toBe('running')
    expect(seen).toEqual(['llm 1'])

    stopGate.resolve()
    await withdrawal
    await drained(app)
    expect(seen).toEqual(['llm 1', 'llm 2'])
    expect(stateOf(app, 'voice.speech').phase).toBe('running')
  })
})

describe('superseded runs', () => {
  // Design test 11, start part.
  it('ignores and records the decision of a start run that a withdrawal superseded', async () => {
    const app = createTestContainer()
    // The gate holds the start hook of speech, so that the withdrawal supersedes a start run in progress.
    const speechStartGate = deferred()
    const llm = provide(app, 'airi.llm', () => 'llm')
    let runSignal: AbortSignal | undefined
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('start', async ({ decide, signal }) => {
          runSignal = signal
          await speechStartGate.promise
          return decide.fail(new Error('late failure'))
        })
        return 'speech'
      },
    })
    void start(app)
    await drained(app)
    const { records } = collectRecords(app)

    const withdrawal = llm.withdraw()
    await drained(app)
    expect(runSignal?.aborted).toBe(true)

    speechStartGate.resolve()
    await withdrawal
    // The withdrawal does not wait for the start run (G2). The late decision arrives after it.
    await drained(app)
    // The fail decision is ignored. The service waits for a provider again. It is not failed.
    expect(stateOf(app, 'voice.speech').phase).toBe('pending')
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'voice.speech', hook: 'start', decision: 'fail', ignored: true }))
  })
})

describe('stop timeouts', () => {
  it('ends a cleanup that awaits the disposal of its own container, and the disposal continues', async () => {
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock, timeouts: { stop: 100 } })
    const later = vi.fn()
    let cleanupDone = false
    provide(app, 'airi.window', ({ effect }) => {
      effect(() => later)
      effect(() => async () => {
        // A dispose after an await is not detected as re-entrant. It gets the promise of the disposal that waits for this cleanup.
        await Promise.resolve()
        await dispose(app).catch(() => {})
        cleanupDone = true
      })
      return 'window'
    })
    await start(app)
    const { records } = collectRecords(app)

    const disposal = dispose(app)
    await drained(app)
    expect(records.filter(record => record.type === 'phase').at(-1)).toMatchObject({ key: 'airi.window', to: 'stopping' })
    expect(later).not.toHaveBeenCalled()

    manual.advance(100)
    await expect(disposal).rejects.toMatchObject({ code: 'hook-timeout', hook: 'stop', timeoutMs: 100 })
    // The remaining disposers still run after the timeout.
    expect(later).toHaveBeenCalledTimes(1)
    expect(records).toContainEqual(expect.objectContaining({ type: 'timeout', key: 'airi.window', hook: 'stop', timeoutMs: 100 }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'airi.window', to: 'withdrawn' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cleanupDone).toBe(true)
  })

  it('aborts the signal of a stop handler at the stop timeout', async () => {
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock, timeouts: { stop: 30 } })
    const signals: AbortSignal[] = []
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', ({ signal }) => {
        signals.push(signal)
        return new Promise<void>(() => {})
      })
      return 'tray'
    })
    await start(app)

    const stopped = stop(app).catch((error: unknown) => error)
    await drained(app)
    expect(signals[0]?.aborted).toBe(false)
    manual.advance(30)
    expect(await stopped).toMatchObject({ code: 'hook-timeout', hook: 'stop' })
    expect(signals[0]?.reason).toMatchObject({ code: 'hook-timeout', hook: 'stop', timeoutMs: 30 })
    expect(manual.pending()).toBe(0)
  })

  it('applies a handled onTimeout decision, so the stop has no error', async () => {
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock })
    const gate = deferred()
    provide(app, 'airi.tray', {
      timeouts: { stop: 20 },
      onTimeout: context => context.hook === 'stop' ? context.decide.handled({ reason: 'the tray closes with the process' }) : undefined,
      build: ({ on }) => {
        on('stop', () => gate.promise)
        return 'tray'
      },
    })
    await start(app)

    const stopped = stop(app)
    await drained(app)
    manual.advance(20)
    await expect(stopped).resolves.toBeUndefined()
    expect(stateOf(app, 'airi.tray').phase).toBe('pending')
  })

  it('waits for a stop without a configured timeout', async () => {
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock })
    const gate = deferred()
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', () => gate.promise)
      return 'tray'
    })
    await start(app)

    const stopped = stop(app)
    await drained(app)
    manual.advance(1_000_000)
    await drained(app)
    expect(stateOf(app, 'airi.tray').phase).toBe('stopping')
    gate.resolve()
    await stopped
    expect(stateOf(app, 'airi.tray').phase).toBe('pending')
  })
})
