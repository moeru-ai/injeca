import { describe, expect, it, vi } from 'vitest'

import { createNoopLogger } from '../diagnostics/logger'
import { createContainer, dispose, provide, start, stop } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, stateOf, warningLogger } from '../testing/helpers'

describe('serial transitions', () => {
  // Design test 6.
  it('builds the unit again after its stop ends when the dependency returns during the stop', async () => {
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
    // The fail decision is ignored. The unit waits for a provider again. It is not failed.
    expect(stateOf(app, 'voice.speech').phase).toBe('pending')
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'voice.speech', hook: 'start', decision: 'fail', ignored: true }))
  })
})

describe('stop timeouts', () => {
  it('ends a cleanup that awaits the disposal of its own container, warns, and the disposal resolves', async () => {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createContainer({ logger, clock: manual.clock, timeouts: { stop: 100 } })
    const later = vi.fn()
    let cleanupDone = false
    provide(app, 'airi.window', ({ effect }) => {
      effect(() => later)
      effect(() => async () => {
        // A dispose after an await is not detected as re-entrant. It gets the promise of the disposal that waits for this cleanup.
        await Promise.resolve()
        await dispose(app)
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
    await expect(disposal).resolves.toBeUndefined()
    // The remaining disposers still run after the timeout.
    expect(later).toHaveBeenCalledTimes(1)
    expect(records).toContainEqual(expect.objectContaining({ type: 'timeout', key: 'airi.window', hook: 'stop', timeoutMs: 100 }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'airi.window', hook: 'stop', decision: 'handled', ignored: false }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'airi.window', to: 'withdrawn' }))
    expect(warnings).toEqual([expect.stringContaining('The container is disposing. A cleanup can be waiting for its own container. It must pass its signal to stop() or dispose().')])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cleanupDone).toBe(true)
  })

  it('resolves stop() for every caller at a stop timeout, and the unit can start again', async () => {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createContainer({ logger, clock: manual.clock, timeouts: { stop: 50 } })
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', () => new Promise<void>(() => {}))
      return 'tray'
    })
    await start(app)

    const first = stop(app)
    const second = stop(app)
    await drained(app)
    manual.advance(50)
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(stateOf(app, 'airi.tray').phase).toBe('pending')
    expect(warnings).toEqual([expect.stringContaining('The container is stopping.')])

    await start(app)
    expect(stateOf(app, 'airi.tray').phase).toBe('running')
  })

  it('warns without the hint when only the unit stops', async () => {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createContainer({ logger, clock: manual.clock, timeouts: { stop: 50 } })
    const llm = provide(app, 'airi.llm', ({ on }) => {
      on('stop', () => new Promise<void>(() => {}))
      return 'llm'
    })
    await start(app)

    const withdrawal = llm.withdraw()
    await drained(app)
    manual.advance(50)
    await expect(withdrawal).resolves.toBe(true)
    expect(warnings).toEqual([expect.stringContaining('did not settle within the stop timeout of 50ms')])
    expect(warnings[0]).not.toContain('The container is')
  })

  it('fails the stop when onTimeout returns fail', async () => {
    const manual = manualClock()
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock })
    const error = new Error('The tray did not close.')
    provide(app, 'airi.tray', {
      timeouts: { stop: 20 },
      onTimeout: context => context.hook === 'stop' ? context.decide.fail(error) : undefined,
      build: ({ on }) => {
        on('stop', () => new Promise<void>(() => {}))
        return 'tray'
      },
    })
    await start(app)

    const stopped = stop(app).catch((reason: unknown) => reason)
    await drained(app)
    manual.advance(20)
    expect(await stopped).toBe(error)
    expect(stateOf(app, 'airi.tray').phase).toBe('failed')
  })

  it('aborts the signal of a stop handler at the stop timeout', async () => {
    const manual = manualClock()
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock, timeouts: { stop: 30 } })
    const signals: AbortSignal[] = []
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', ({ signal }) => {
        signals.push(signal)
        return new Promise<void>(() => {})
      })
      return 'tray'
    })
    await start(app)

    const stopped = stop(app)
    await drained(app)
    expect(signals[0]?.aborted).toBe(false)
    manual.advance(30)
    await expect(stopped).resolves.toBeUndefined()
    expect(signals[0]?.reason).toMatchObject({ code: 'hook-timeout', hook: 'stop', timeoutMs: 30 })
    expect(manual.pending()).toBe(0)
  })

  it('applies a handled onTimeout decision, so the stop has no error', async () => {
    const manual = manualClock()
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock })
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
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock })
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

describe('late failures of abandoned cleanups', () => {
  /** Lets the callbacks that injeca abandoned settle. */
  const settleLate = () => new Promise(resolve => setTimeout(resolve, 0))

  it('warns and records a stop hook that rejects after the stop timeout', async () => {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createContainer({ logger, clock: manual.clock, timeouts: { stop: 40 } })
    const gate = deferred()
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', async () => {
        await gate.promise
        throw new Error('The tray closed late.')
      })
      return 'tray'
    })
    await start(app)
    const { records } = collectRecords(app)

    const stopped = stop(app)
    await drained(app)
    manual.advance(40)
    await expect(stopped).resolves.toBeUndefined()

    gate.resolve()
    await settleLate()
    expect(warnings).toEqual([
      expect.stringContaining('did not settle within the stop timeout'),
      'The \'stop\' hook of \'airi.tray\' failed after injeca stopped waiting for it: The tray closed late.',
    ])
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'airi.tray', hook: 'stop', decision: 'fail', ignored: true }))
  })

  it('warns for an effect disposer that rejects after the stop timeout, also when injeca did not wait for it at all', async () => {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createContainer({ logger, clock: manual.clock, timeouts: { stop: 40 } })
    const gate = deferred()
    provide(app, 'airi.window', ({ effect }) => {
      effect(() => async () => {
        await gate.promise
        throw new Error('second')
      })
      effect(() => async () => {
        await gate.promise
        throw new Error('first')
      })
      return 'window'
    })
    await start(app)

    const disposal = dispose(app)
    await drained(app)
    manual.advance(40)
    await expect(disposal).resolves.toBeUndefined()

    gate.resolve()
    await settleLate()
    expect(warnings.slice(1)).toEqual([
      'An effect disposer of \'airi.window\' failed after injeca stopped waiting for it: first',
      'An effect disposer of \'airi.window\' failed after injeca stopped waiting for it: second',
    ])
  })

  it('does not warn twice for a cleanup that rethrows the timeout of its signal', async () => {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createContainer({ logger, clock: manual.clock, timeouts: { stop: 40 } })
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', ({ signal }) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      return 'tray'
    })
    await start(app)

    const stopped = stop(app)
    await drained(app)
    manual.advance(40)
    await expect(stopped).resolves.toBeUndefined()
    await settleLate()
    expect(warnings).toEqual([expect.stringContaining('did not settle within the stop timeout')])
  })

  it('warns for a superseded start hook that rejects later, but not for one that follows its abort', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const gate = deferred()
    provide(app, 'airi.server', ({ on }) => {
      on('start', async () => {
        await gate.promise
        throw new Error('The port is busy.')
      })
      return 'server'
    })
    provide(app, 'airi.client', ({ on }) => {
      on('start', ({ signal }) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      return 'client'
    })
    void start(app).catch(() => {})
    await drained(app)

    await stop(app)
    gate.resolve()
    await settleLate()
    expect(warnings).toEqual(['The \'start\' hook of \'airi.server\' failed after injeca stopped waiting for it: The port is busy.'])
  })
})
