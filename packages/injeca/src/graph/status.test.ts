import type { BuildContext, StatusCause } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { InvalidArgumentError, StartTimeoutError } from '../diagnostics/errors'
import { defineKey, graph, optional, provide, start, timeout } from '../scoped'
import { collectRecords, createTestContainer, drained, manualClock, stateOf } from '../testing/helpers'

type SetStatus = BuildContext['setStatus']

/** Provides a service that exposes its `setStatus` to the test. */
function provideWithStatus(app: ReturnType<typeof createTestContainer>, name: string) {
  const handle: { setStatus: SetStatus } = { setStatus: () => {} }
  const registration = provide(app, name, ({ setStatus }) => {
    handle.setStatus = setStatus
    return name
  })

  return Object.assign(handle, { registration })
}

describe('effective status', () => {
  it('is ready after start, and undefined outside running', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    expect(stateOf(app, 'airi.llm')).toEqual({ phase: 'pending', status: undefined, instanceId: undefined })

    await start(app)
    expect(stateOf(app, 'airi.llm')).toMatchObject({ phase: 'running', status: 'ready' })
    expect(stateOf(app, 'missing')).toEqual({ phase: undefined, status: undefined, instanceId: undefined })
  })

  // Design test 18.
  it('does not stop or rebuild a running dependent when a dependency becomes unavailable, and a pending dependent does not start', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    const speechBuild = vi.fn(() => 'speech')
    const speechStop = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        on('stop', speechStop)
        return speechBuild()
      },
    })
    await start(app)
    const instanceId = stateOf(app, 'voice.speech').instanceId

    llm.setStatus('unavailable', 'offline')
    await drained(app)
    expect(speechBuild).toHaveBeenCalledTimes(1)
    expect(speechStop).not.toHaveBeenCalled()
    expect(stateOf(app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'unavailable', instanceId })

    const summaryBuild = vi.fn(() => 'summary')
    provide(app, 'voice.summary', { dependsOn: { llm: llm.registration }, build: summaryBuild })
    await drained(app)
    expect(stateOf(app, 'voice.summary').phase).toBe('pending')
    expect(summaryBuild).not.toHaveBeenCalled()

    llm.setStatus('ready')
    await drained(app)
    expect(stateOf(app, 'voice.summary')).toMatchObject({ phase: 'running', status: 'ready' })
    expect(stateOf(app, 'voice.speech')).toMatchObject({ status: 'ready', instanceId })
  })

  // Design test 19.
  it('takes no action for a status change without a dependency-status-change handler', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    const build = vi.fn(() => 'speech')
    const stopHook = vi.fn()
    const dependencyChange = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        on('stop', stopHook)
        // A dependency-change handler does not get status changes.
        on('dependency-change', dependencyChange)
        return build()
      },
    })
    await start(app)

    llm.setStatus('degraded', 'fallback voice')
    await drained(app)
    llm.setStatus('unavailable')
    await drained(app)
    llm.setStatus('ready')
    await drained(app)

    expect(build).toHaveBeenCalledTimes(1)
    expect(stopHook).not.toHaveBeenCalled()
    expect(dependencyChange).not.toHaveBeenCalled()
    expect(stateOf(app, 'voice.speech').status).toBe('ready')
  })

  // Design test 21.
  it('makes each dependent and their dependents unavailable without a stop or a rebuild', async () => {
    const app = createTestContainer({ owner: { kind: 'host' } })
    const llm = provideWithStatus(app, 'airi.llm')
    const builds = vi.fn()
    const speech = provide(app, 'voice.speech', { dependsOn: { llm: llm.registration }, build: () => builds('speech') })
    provide(app, 'voice.summary', { dependsOn: { speech }, build: () => builds('summary') })
    await start(app)

    llm.setStatus('unavailable', 'offline')
    await drained(app)

    expect(stateOf(app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'unavailable' })
    expect(stateOf(app, 'voice.summary')).toMatchObject({
      phase: 'running',
      status: 'unavailable',
      cause: {
        key: 'voice.speech',
        owner: { kind: 'host' },
        status: 'unavailable',
        cause: { key: 'airi.llm', owner: { kind: 'host' }, status: 'unavailable', reason: 'offline' },
      },
    })
    expect(builds).toHaveBeenCalledTimes(2)
  })

  // Design test 22.
  it('does not change the effective status for an unavailable optional dependency', async () => {
    const app = createTestContainer()
    const ttsKey = defineKey<string>('airi.tts')
    const tts = provideWithStatus(app, ttsKey.key)
    const seen: unknown[] = []
    provide(app, 'voice.speech', {
      dependsOn: { tts: optional(ttsKey) },
      build: ({ dependsOn, on }) => {
        seen.push(dependsOn.tts)
        on('dependency-status-change', ({ dependsOn, decide }) => {
          seen.push(dependsOn.tts?.status)
          return decide.handled()
        })
        return 'speech'
      },
    })
    await start(app)

    tts.setStatus('unavailable')
    await drained(app)

    expect(stateOf(app, 'voice.speech').status).toBe('ready')
    // The first build does not wait for the optional provider. It appears, and 'voice.speech' rebuilds.
    // Then the optional dependency reports its real status, and the handler gets the change.
    expect(seen).toEqual([undefined, { value: 'airi.tts', status: 'ready' }, 'unavailable'])
  })

  it('gives the real status of an optional dependency to build', async () => {
    const app = createTestContainer()
    const tts = provideWithStatus(app, 'airi.tts')
    await start(app)
    tts.setStatus('degraded')

    const seen: unknown[] = []
    provide(app, 'voice.speech', {
      dependsOn: { tts: optional('airi.tts') },
      build: ({ dependsOn }) => seen.push(dependsOn.tts),
    })
    await drained(app)
    expect(seen).toEqual([{ value: 'airi.tts', status: 'degraded' }])
  })

  // Design test 23.
  it('does not let a service report an effective status better than its required dependencies', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    const speech = provideWithStatus(app, 'voice.speech-base')
    const consumer = provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration, base: speech.registration },
      build: ({ setStatus }) => {
        speech.setStatus = setStatus
        return 'speech'
      },
    })
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    speech.setStatus('ready')
    expect(stateOf(app, consumer).status).toBe('degraded')

    // A service can make its effective status worse than its dependencies.
    speech.setStatus('unavailable', 'own problem')
    expect(stateOf(app, consumer)).toMatchObject({ status: 'unavailable', reason: 'own problem' })
  })

  // Design test 36.
  it('changes the own status and the effective status of dependents with setStatus after build, and ignores a call after disposal', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    provide(app, 'voice.speech', { dependsOn: { llm: llm.registration }, build: () => 'speech' })
    await start(app)
    const { records } = collectRecords(app)

    llm.setStatus('degraded', 'slow network')
    expect(stateOf(app, 'airi.llm')).toMatchObject({ status: 'degraded', reason: 'slow network' })
    expect(stateOf(app, 'voice.speech')).toMatchObject({ status: 'degraded', cause: { key: 'airi.llm', status: 'degraded', reason: 'slow network' } })

    const setStatus = llm.setStatus
    const instanceId = stateOf(app, 'airi.llm').instanceId
    await llm.registration.withdraw()
    setStatus('unavailable')

    expect(stateOf(app, 'voice.speech').phase).toBe('pending')
    expect(records).toContainEqual(expect.objectContaining({ type: 'ignored', call: 'setStatus', key: 'airi.llm', instanceId }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'status', key: 'voice.speech', from: 'ready', to: 'degraded' }))
  })

  it('rejects an invalid status or cause', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    await start(app)

    expect(() => llm.setStatus('broken' as 'ready')).toThrow(InvalidArgumentError)
    expect(() => llm.setStatus('unavailable', { cause: { key: '', owner: {}, status: 'unavailable' } })).toThrow(InvalidArgumentError)
    expect(() => llm.setStatus('unavailable', 42 as unknown as string)).toThrow(InvalidArgumentError)
  })

  // Design test 37.
  it('shows a cause chain from setStatus in the explanation of a dependent', async () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock, owner: { kind: 'host' } })
    const proxy = provideWithStatus(app, 'gateway.logs')
    provide(app, 'voice.speech', { dependsOn: { logs: proxy.registration }, build: () => 'speech' })
    await start(app)

    const remoteCause: StatusCause = {
      key: 'go-ai-gateway/fs-log-store',
      owner: { kind: 'plugin', id: 'go-ai-gateway' },
      status: 'unavailable',
      reason: 'disk full',
    }
    proxy.setStatus('unavailable', { reason: 'the remote store is offline', cause: remoteCause })

    const chain = { key: 'gateway.logs', owner: { kind: 'host' }, status: 'unavailable', reason: 'the remote store is offline', cause: remoteCause }
    expect(graph(app).explain('voice.speech')).toMatchObject({ phase: 'running', status: 'unavailable', cause: chain })

    // A dependent that waits lists the unavailable dependency as a blocker, with the same chain.
    provide(app, 'voice.summary', { dependsOn: { logs: proxy.registration }, build: () => 'summary' })
    const result = start(app, { signal: timeout(app, 100) }).catch((error: unknown) => error)
    await drained(app)
    advance(100)

    const failure = await result as StartTimeoutError
    expect(failure).toBeInstanceOf(StartTimeoutError)
    expect(failure.explanations).toEqual([
      expect.objectContaining({ name: 'voice.summary', phase: 'pending', blockers: [{ kind: 'unavailable-dependency', dependency: 'logs', key: 'gateway.logs', cause: chain }] }),
    ])
    expect(failure.message).toContain('\'go-ai-gateway/fs-log-store\' is unavailable (disk full)')
  })
})
