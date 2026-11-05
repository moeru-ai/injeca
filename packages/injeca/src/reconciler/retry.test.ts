import type { Container, HookContext, ObserveRecord, PhaseObserveRecord } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { createContainer, provide, start, stop } from '../scoped'
import { collectRecords, drained, manualClock, provideWithStatus, stateOf } from '../testing/helpers'

type StartHandler = (context: HookContext<'start'>) => unknown

/** Provides `voice.speech` that requires `airi.llm`. Its `start` hook is `handler`. */
function provideSpeech(app: Container, handler: StartHandler, options: { maxAttempts?: number } = {}) {
  const builds = vi.fn()
  const stopHook = vi.fn()
  const instanceIds: string[] = []
  const registration = provide(app, 'voice.speech', {
    dependsOn: { llm: 'airi.llm' },
    ...options,
    build: ({ on, instanceId }) => {
      builds()
      instanceIds.push(instanceId)
      on('start', handler)
      on('stop', stopHook)
      return 'speech'
    },
  })

  return { registration, builds, stopHook, instanceIds }
}

function setup(handler: StartHandler, options: { maxAttempts?: number, containerMaxAttempts?: number } = {}) {
  const manual = manualClock()
  const app = createContainer({ enabled: false, clock: manual.clock, maxAttempts: options.containerMaxAttempts })
  const llm = provideWithStatus(app, 'airi.llm')
  const speech = provideSpeech(app, handler, { maxAttempts: options.maxAttempts })

  return { ...manual, app, llm, ...speech }
}

/** The last phase record of `key`. */
function lastPhase(records: readonly ObserveRecord[], key: string): PhaseObserveRecord | undefined {
  return records.filter((record): record is PhaseObserveRecord => record.type === 'phase' && record.key === key).at(-1)
}

/** Moves the clock forward and waits until the reconciler drained. */
async function tick(manual: { advance: (ms: number) => void }, app: Container, ms: number): Promise<void> {
  manual.advance(ms)
  await drained(app)
}

describe('start requeue', () => {
  it('keeps the instance, runs start again without build, and is retrying and not available during the wait', async () => {
    const attempts: number[] = []
    const ctx = setup(({ decide, attempt }) => {
      attempts.push(attempt)
      return attempt < 3 ? decide.requeue({ after: 100, reason: 'port is busy' }) : undefined
    })
    const { records } = collectRecords(ctx.app)
    provide(ctx.app, 'voice.ui', { dependsOn: { speech: 'voice.speech' }, build: () => 'ui' })
    const started = start(ctx.app)
    await drained(ctx.app)

    expect(stateOf(ctx.app, 'voice.speech')).toMatchObject({ phase: 'retrying', status: undefined })
    expect(lastPhase(records, 'voice.speech')).toMatchObject({ to: 'retrying', reason: 'port is busy', decision: 'requeue' })
    expect(stateOf(ctx.app, 'voice.ui').phase).toBe('pending')
    // The retrying service still holds its dependency. A withdrawal waits for it.
    expect(stateOf(ctx.app, 'airi.llm').phase).toBe('running')

    await tick(ctx, ctx.app, 100)
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('retrying')
    await tick(ctx, ctx.app, 100)
    await started

    expect(attempts).toEqual([1, 2, 3])
    expect(ctx.builds).toHaveBeenCalledTimes(1)
    expect(new Set(ctx.instanceIds).size).toBe(1)
    expect(stateOf(ctx.app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'ready', instanceId: ctx.instanceIds[0] })
    expect(stateOf(ctx.app, 'voice.ui').phase).toBe('running')
    const phases = records.filter((record): record is PhaseObserveRecord => record.type === 'phase' && record.key === 'voice.speech').map(record => record.to)
    expect(phases).toEqual(['pending', 'building', 'starting', 'retrying', 'starting', 'retrying', 'starting', 'running'])
  })

  // Design test 9, start hook part.
  it('moves the service to failed when the requeue reaches maxAttempts, after its stop', async () => {
    const ctx = setup(({ decide }) => decide.requeue({ after: 10, maxAttempts: 3, reason: 'device is busy' }))
    const { records } = collectRecords(ctx.app)
    const started = start(ctx.app)
    const rejection = expect(started).rejects.toThrow('device is busy')
    await drained(ctx.app)
    await tick(ctx, ctx.app, 10)
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('retrying')
    expect(ctx.stopHook).not.toHaveBeenCalled()

    await tick(ctx, ctx.app, 10)
    await rejection
    expect(ctx.stopHook).toHaveBeenCalledTimes(1)
    expect(lastPhase(records, 'voice.speech')).toMatchObject({ from: 'stopping', to: 'failed', reason: 'device is busy', decision: 'requeue' })
    expect(ctx.pending()).toBe(0)
  })

  // Design test 9, second part.
  it('keeps retrying without maxAttempts', async () => {
    const attempts: number[] = []
    const ctx = setup(({ decide, attempt }) => {
      attempts.push(attempt)
      return decide.requeue({ backoff: { kind: 'exponential', initial: 10, max: 40 } })
    })
    void start(ctx.app)
    await drained(ctx.app)
    for (const delay of [10, 20, 40, 40, 40, 40])
      await tick(ctx, ctx.app, delay)

    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(ctx.pending()).toBe(1)
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('retrying')
  })

  // Design test 28.
  it('cancels the retry and stops the service when a required dependency is withdrawn during the wait', async () => {
    const ctx = setup(({ decide }) => decide.requeue({ after: 1_000 }))
    const { records } = collectRecords(ctx.app)
    void start(ctx.app)
    await drained(ctx.app)
    expect(ctx.pending()).toBe(1)

    await ctx.llm.registration.withdraw()
    expect(ctx.stopHook).toHaveBeenCalledTimes(1)
    expect(ctx.pending()).toBe(0)
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('pending')
    expect(records.some(record => record.type === 'phase' && record.key === 'voice.speech' && record.to === 'stopping' && record.reason === 'A required dependency was withdrawn during a start requeue.')).toBe(true)
  })

  it('cancels the retry when the container stops', async () => {
    const ctx = setup(({ decide }) => decide.requeue({ after: 1_000 }))
    void start(ctx.app)
    await drained(ctx.app)

    await stop(ctx.app)
    expect(ctx.pending()).toBe(0)
    expect(ctx.stopHook).toHaveBeenCalledTimes(1)
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('pending')
  })

  // Design test 8, for start hooks.
  it('merges the changes during the wait into one attempt, and the running service then handles the latest snapshot', async () => {
    const statusRuns: string[][] = []
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock })
    const llm = provideWithStatus(app, 'airi.llm')
    const starts = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: 'airi.llm' },
      build: ({ on }) => {
        on('start', ({ decide, attempt }) => {
          starts()
          return attempt === 1 ? decide.requeue({ after: 100 }) : undefined
        })
        on('dependency-status-change', ({ dependsOn, decide }) => {
          statusRuns.push([String(dependsOn.llm.status)])
          return decide.handled()
        })
        return 'speech'
      },
    })
    void start(app)
    await drained(app)

    llm.setStatus('degraded')
    await drained(app)
    llm.setStatus('unavailable')
    await drained(app)
    expect(starts).toHaveBeenCalledTimes(1)

    await tick(manual, app, 100)
    expect(starts).toHaveBeenCalledTimes(2)
    expect(statusRuns).toEqual([['unavailable']])
    expect(stateOf(app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'unavailable' })
  })

  it('runs the start handler that requeued again, and not the handlers before it', async () => {
    const manual = manualClock()
    const app = createContainer({ enabled: false, clock: manual.clock })
    const calls: string[] = []
    provide(app, 'airi.server', ({ on }) => {
      on('start', () => {
        calls.push('listen')
      })
      on('start', ({ decide, attempt }) => {
        calls.push(`connect ${attempt}`)
        return attempt === 1 ? decide.requeue({ after: 5 }) : decide.handled()
      })
      on('start', () => {
        calls.push('announce')
      })
      return 'server'
    })
    const started = start(app)
    await drained(app)
    await tick(manual, app, 5)
    await started

    expect(calls).toEqual(['listen', 'connect 1', 'connect 2', 'announce'])
  })
})

describe('maxAttempts precedence', () => {
  async function runUntilSettled(ctx: ReturnType<typeof setup>, attempts: number[]): Promise<void> {
    void start(ctx.app).catch(() => {})
    await drained(ctx.app)
    for (let index = 0; index < 10 && stateOf(ctx.app, 'voice.speech').phase === 'retrying'; index++)
      await tick(ctx, ctx.app, 10)
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('failed')
    expect(attempts.length).toBeGreaterThan(0)
  }

  it('uses the container value, then the service value, then the decision value', async () => {
    const cases = [
      { options: { containerMaxAttempts: 2 }, decision: undefined, expected: 2 },
      { options: { containerMaxAttempts: 2, maxAttempts: 4 }, decision: undefined, expected: 4 },
      { options: { containerMaxAttempts: 2, maxAttempts: 4 }, decision: 3, expected: 3 },
    ]
    for (const { options, decision, expected } of cases) {
      const attempts: number[] = []
      const ctx = setup(({ decide, attempt }) => {
        attempts.push(attempt)
        return decide.requeue({ after: 10, ...(decision === undefined ? {} : { maxAttempts: decision }) })
      }, options)
      await runUntilSettled(ctx, attempts)
      expect(attempts).toHaveLength(expected)
    }
  })

  it('uses the value of the nearest ancestor container', async () => {
    const manual = manualClock()
    const root = createContainer({ enabled: false, clock: manual.clock, maxAttempts: 2 })
    const child = createContainer({ parent: root })
    provideWithStatus(root, 'airi.llm')
    const attempts: number[] = []
    provideSpeech(child, ({ decide, attempt }) => {
      attempts.push(attempt)
      return decide.requeue({ after: 10 })
    })
    void start(root)
    void start(child).catch(() => {})
    await drained(root)
    await tick(manual, root, 10)

    expect(attempts).toEqual([1, 2])
    expect(stateOf(child, 'voice.speech').phase).toBe('failed')
  })

  it('rejects a maxAttempts that is not a positive integer', () => {
    const app = createContainer({ enabled: false })
    expect(() => provide(app, 'airi.bad', { maxAttempts: 0, build: () => 1 })).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
    expect(() => createContainer({ enabled: false, maxAttempts: 1.5 })).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
  })
})

describe('recovery from failed', () => {
  async function failSpeech() {
    let fail = true
    const ctx = setup(({ decide }) => fail ? decide.requeue({ after: 10, maxAttempts: 1, reason: 'no device' }) : undefined)
    await expect(start(ctx.app)).rejects.toThrow('no device')
    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('failed')
    fail = false
    return ctx
  }

  it('moves out of failed when start() runs again', async () => {
    const ctx = await failSpeech()
    await start(ctx.app)

    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('running')
    expect(ctx.builds).toHaveBeenCalledTimes(2)
  })

  it('moves out of failed when the configuration is replaced', async () => {
    const ctx = await failSpeech()
    await expect(ctx.registration.replace({ dependsOn: { llm: 'airi.llm' }, build: () => 'speech v2' })).resolves.toBe(true)
    await drained(ctx.app)

    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('running')
  })

  it('moves out of failed when the container is stopped and started again', async () => {
    const ctx = await failSpeech()
    await stop(ctx.app)
    await start(ctx.app)

    expect(stateOf(ctx.app, 'voice.speech').phase).toBe('running')
  })
})
