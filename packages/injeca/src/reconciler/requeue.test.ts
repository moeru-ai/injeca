import type { HookHandler, OptionalValue, UnitStatus } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { createNoopLogger } from '../diagnostics/logger'
import { createContainer, defineKey, optional, provide, start } from '../scoped'
import { drained, manualClock, provideWithStatus, stateOf } from '../testing/helpers'

describe('dependency hook requeue', () => {
  function setup(handler: HookHandler<'dependency-status-change', { llm: string, tts: OptionalValue<string> | undefined }>) {
    const manual = manualClock()
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock })
    const llm = provideWithStatus(app, 'airi.llm')
    const tts = provideWithStatus(app, 'airi.tts')
    const stopHook = vi.fn()
    const builds = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration, tts: optional(defineKey<string>('airi.tts')) },
      build: ({ on }) => {
        builds()
        on('stop', stopHook)
        on('dependency-status-change', handler)
        return 'speech'
      },
    })

    return { ...manual, app, llm, tts, stopHook, builds }
  }

  // Design test 8, for dependency hooks.
  it('merges the changes during a waiting requeue into one run with the latest snapshot', async () => {
    const runs: { attempt: number, previous: string | undefined, llm: UnitStatus, tts: UnitStatus | undefined, changes: string[] }[] = []
    const { app, llm, tts, advance, builds } = setup(({ attempt, previous, dependsOn, changes, decide }) => {
      runs.push({ attempt, previous: previous?.kind, llm: dependsOn.llm.status, tts: dependsOn.tts?.status, changes: changes.map(change => change.key) })
      return runs.length === 1 ? decide.requeue({ after: 100, reason: 'warming up' }) : decide.handled()
    })
    await start(app)
    const buildCount = builds.mock.calls.length

    llm.setStatus('degraded')
    await drained(app)
    expect(runs).toHaveLength(1)
    expect(stateOf(app, 'voice.speech').phase).toBe('running')

    tts.setStatus('degraded')
    llm.setStatus('unavailable')
    await drained(app)
    tts.setStatus('unavailable')
    await drained(app)
    expect(runs).toHaveLength(1)

    advance(99)
    await drained(app)
    expect(runs).toHaveLength(1)
    advance(1)
    await drained(app)

    expect(runs).toEqual([
      { attempt: 1, previous: undefined, llm: 'degraded', tts: 'ready', changes: ['llm'] },
      { attempt: 2, previous: 'requeue', llm: 'unavailable', tts: 'unavailable', changes: ['llm', 'tts'] },
    ])
    expect(builds).toHaveBeenCalledTimes(buildCount)
  })

  // Design test 29, dependency hook part.
  it('stops a running unit when a requeue reaches maxAttempts, then moves it to failed with the last reason', async () => {
    const { app, llm, advance, stopHook } = setup(({ decide }) => decide.requeue({ after: 10, maxAttempts: 3, reason: 'llm is not ready' }))
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    advance(10)
    await drained(app)
    expect(stateOf(app, 'voice.speech').phase).toBe('running')
    expect(stopHook).not.toHaveBeenCalled()

    advance(10)
    await drained(app)
    expect(stopHook).toHaveBeenCalledTimes(1)
    expect(stateOf(app, 'voice.speech').phase).toBe('failed')
    await expect(start(app).then(() => 'ran again')).resolves.toBe('ran again')
  })

  it('keeps retrying without maxAttempts, and uses an exponential backoff', async () => {
    const attempts: number[] = []
    const { app, llm, advance, pending } = setup(({ decide, attempt }) => {
      attempts.push(attempt)
      return decide.requeue({ backoff: { kind: 'exponential', initial: 10, max: 40 } })
    })
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    for (const delay of [10, 20, 40, 40, 40]) {
      advance(delay - 1)
      await drained(app)
      advance(1)
      await drained(app)
    }

    expect(attempts).toEqual([1, 2, 3, 4, 5, 6])
    expect(pending()).toBe(1)
    expect(stateOf(app, 'voice.speech').phase).toBe('running')
  })

  it('cancels the wait and stops at once when a required dependency is withdrawn during the wait', async () => {
    const { app, llm, pending, stopHook } = setup(({ decide }) => decide.requeue({ after: 1_000 }))
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    expect(pending()).toBe(1)

    await llm.registration.withdraw()
    expect(stopHook).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(0)
    expect(stateOf(app, 'voice.speech').phase).toBe('pending')
  })

  it('applies the jitter through the injected random source, so the delays are deterministic', async () => {
    const manual = manualClock()
    const random = vi.fn(() => 0.5)
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock, random })
    const llm = provideWithStatus(app, 'airi.llm')
    const runs: number[] = []
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        on('dependency-status-change', ({ decide }) => {
          runs.push(manual.clock.now())
          return decide.requeue({ backoff: { kind: 'exponential', initial: 100, max: 1_000, jitter: 0.5 } })
        })
        return 'speech'
      },
    })
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    // Each delay is `delay * (1 - 0.5 * 0.5)`: 75, 150, then 300.
    for (const delay of [75, 150, 300]) {
      manual.advance(delay - 1)
      await drained(app)
      manual.advance(1)
      await drained(app)
    }

    expect(runs).toEqual([0, 75, 225, 525])
    expect(random).toHaveBeenCalledTimes(4)
  })

  it('does not read the random source without jitter', async () => {
    const random = vi.fn(() => 0.5)
    const manual = manualClock()
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock, random })
    const llm = provideWithStatus(app, 'airi.llm')
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        on('dependency-status-change', ({ decide }) => decide.requeue({ backoff: { kind: 'exponential', initial: 10, max: 10 } }))
        return 'speech'
      },
    })
    await start(app)
    llm.setStatus('degraded')
    await drained(app)
    manual.advance(10)
    await drained(app)

    expect(random).not.toHaveBeenCalled()
  })

  it('uses the maxAttempts of the unit for a dependency hook requeue', async () => {
    const manual = manualClock()
    const app = createContainer({ logger: createNoopLogger(), clock: manual.clock, maxAttempts: 10 })
    const llm = provideWithStatus(app, 'airi.llm')
    const attempts: number[] = []
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      maxAttempts: 2,
      build: ({ on }) => {
        on('dependency-status-change', ({ decide, attempt }) => {
          attempts.push(attempt)
          return decide.requeue({ after: 10 })
        })
        return 'speech'
      },
    })
    await start(app)
    llm.setStatus('degraded')
    await drained(app)
    manual.advance(10)
    await drained(app)

    expect(attempts).toEqual([1, 2])
    expect(stateOf(app, 'voice.speech').phase).toBe('failed')
  })
})
