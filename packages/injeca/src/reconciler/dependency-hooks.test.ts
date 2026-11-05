import type { Decide } from '../primitives/decision'
import type { DependencyChange, ServiceStatus } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { firstAvailable, optional, provide, start } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, provideWithStatus, stateOf } from '../testing/helpers'

describe('dependency-change', () => {
  // A selection change of `firstAvailable` replaces a required dependency without a gap: both providers run.
  function fallbackPair(remoteStop?: () => void) {
    const app = createTestContainer()
    const remote = provideWithStatus(app, 'airi.llm.remote', remoteStop)
    const local = provideWithStatus(app, 'airi.llm.local')
    const llm = firstAvailable(remote.registration, local.registration)

    return { app, remote, local, llm }
  }

  it('calls the handler for a replaced required dependency, moves the binding, and releases the old instance', async () => {
    const remoteStop = vi.fn()
    const { app, remote, llm } = fallbackPair(remoteStop)
    const builds = vi.fn()
    const calls: { value: unknown, changes: readonly DependencyChange[], attempt: number }[] = []

    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ dependsOn, on }) => {
        builds(dependsOn.llm)
        on('dependency-change', ({ dependsOn, changes, decide, attempt }) => {
          calls.push({ value: dependsOn.llm.value, changes, attempt })
          return decide.handled({ reason: 'moved in place' })
        })
        return 'speech'
      },
    })
    await start(app)
    const remoteId = stateOf(app, 'airi.llm.remote').instanceId
    const localId = stateOf(app, 'airi.llm.local').instanceId

    remote.setStatus('unavailable')
    await drained(app)

    expect(builds).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([{
      value: 'airi.llm.local',
      attempt: 1,
      changes: [{ key: 'llm', from: { provider: 'airi.llm.remote', instanceId: remoteId, status: 'ready' }, to: { provider: 'airi.llm.local', instanceId: localId, status: 'ready' } }],
    }])

    // Nothing holds the old instance now, so its withdrawal does not wait for 'voice.speech'.
    await remote.registration.withdraw()
    expect(remoteStop).toHaveBeenCalledTimes(1)
    expect(stateOf(app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'ready' })
    expect(builds).toHaveBeenCalledTimes(1)
  })

  it('rebuilds for a replaced required dependency without a handler, and when a handler returns undefined', async () => {
    const { app, remote, llm } = fallbackPair()
    const seen: unknown[] = []
    provide(app, 'plain', { dependsOn: { llm }, build: ({ dependsOn }) => seen.push(`plain:${String(dependsOn.llm)}`) })
    provide(app, 'undecided', {
      dependsOn: { llm },
      build: ({ dependsOn, on }) => {
        on('dependency-change', () => {})
        return seen.push(`undecided:${String(dependsOn.llm)}`)
      },
    })
    await start(app)

    remote.setStatus('unavailable')
    await drained(app)
    expect(seen.sort()).toEqual(['plain:airi.llm.local', 'plain:airi.llm.remote', 'undecided:airi.llm.local', 'undecided:airi.llm.remote'])
  })

  it('stops for a withdrawn required dependency, gives the handler a notice only, and records its decision as ignored', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'llm')
    const stopHook = vi.fn()
    const notices: { changes: readonly DependencyChange[], value: unknown }[] = []
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('stop', stopHook)
        on('dependency-change', ({ changes, dependsOn, decide }) => {
          // The withdrawn provider waits for this holder, so its value is still usable.
          notices.push({ changes, value: dependsOn.llm.value })
          return decide.handled()
        })
        return 'speech'
      },
    })
    await start(app)
    const { records } = collectRecords(app)

    await llm.withdraw()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.value).toBe('llm')
    expect(notices[0]!.changes).toEqual([{ key: 'llm', from: expect.objectContaining({ provider: 'airi.llm' }), to: undefined }])
    expect(stopHook).toHaveBeenCalledTimes(1)
    expect(stateOf(app, 'voice.speech').phase).toBe('pending')
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'voice.speech', hook: 'dependency-change', decision: 'handled', ignored: true }))
  })

  it('calls the handler when an optional dependency appears, is replaced, and disappears, and passes the previous decision', async () => {
    const root = createTestContainer()
    const child = createTestContainer({ parent: root })
    const builds = vi.fn()
    const calls: { tts: unknown, previous: string | undefined }[] = []

    provide(child, 'voice.speech', {
      dependsOn: { tts: optional('airi.tts') },
      build: ({ on }) => {
        builds()
        on('dependency-change', ({ dependsOn, decide, previous }) => {
          calls.push({ tts: dependsOn.tts?.value, previous: previous?.reason })
          return decide.handled({ reason: `call ${calls.length}` })
        })
        return 'speech'
      },
    })
    await start(root)
    await start(child)

    const rootTts = provide(root, 'airi.tts', () => 'root tts')
    await drained(root)
    const childTts = provide(child, 'airi.tts', () => 'child tts')
    await drained(root)
    await childTts.withdraw()
    await drained(root)
    await rootTts.withdraw()
    await drained(root)

    expect(builds).toHaveBeenCalledTimes(1)
    // The child provider shadows the root provider as soon as it registers, so the dependency disappears until it runs.
    expect(calls).toEqual([
      { tts: 'root tts', previous: undefined },
      { tts: undefined, previous: 'call 1' },
      { tts: 'child tts', previous: 'call 2' },
      { tts: 'root tts', previous: 'call 3' },
      { tts: undefined, previous: 'call 4' },
    ])
  })

  it('parks the service for decide.stop until the epoch changes, and fails it for decide.fail', async () => {
    const { app, remote, llm } = fallbackPair()
    const error = new Error('cannot move')
    const parked = provide(app, 'voice.parked', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('dependency-change', ({ decide }) => decide.stop({ reason: 'wait for a new epoch' }))
        return 'parked'
      },
    })
    provide(app, 'voice.failing', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('dependency-change', ({ decide }) => decide.fail(error))
        return 'failing'
      },
    })
    await start(app)

    remote.setStatus('unavailable')
    await drained(app)
    expect(stateOf(app, parked).phase).toBe('pending')
    expect(stateOf(app, 'voice.failing').phase).toBe('failed')

    // The remote provider returns. The selection is a new epoch for the parked service.
    remote.setStatus('ready')
    await drained(app)
    expect(stateOf(app, parked).phase).toBe('running')
  })
})

describe('dependency-status-change', () => {
  it('calls the handler with the snapshot and the changes, and keeps the instance', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    const calls: { status: ServiceStatus, changes: readonly DependencyChange[] }[] = []
    const builds = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        builds()
        on('dependency-status-change', ({ dependsOn, changes, decide }) => {
          calls.push({ status: dependsOn.llm.status, changes })
          return decide.handled()
        })
        return 'speech'
      },
    })
    await start(app)
    const llmId = stateOf(app, 'airi.llm').instanceId

    llm.setStatus('degraded')
    await drained(app)
    llm.setStatus('degraded', 'same status, another reason')
    await drained(app)

    expect(builds).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([{
      status: 'degraded',
      changes: [{ key: 'llm', from: { provider: 'airi.llm', instanceId: llmId, status: 'ready' }, to: { provider: 'airi.llm', instanceId: llmId, status: 'degraded' } }],
    }])
  })

  it('rebuilds for decide.rebuild', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    const builds = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        builds()
        on('dependency-status-change', ({ decide }) => decide.rebuild())
        return 'speech'
      },
    })
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    expect(builds).toHaveBeenCalledTimes(2)
  })

  // Design test 11, run-time part.
  it('fails the service for a decision from another run, and ignores and records the decision of a superseded run', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    let foreign: Decide['handled'] | undefined
    provide(app, 'first', ({ on }) => {
      on('start', ({ decide }) => {
        foreign = decide.handled
      })
      return 'first'
    })
    await start(app)

    provide(app, 'second', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        on('dependency-status-change', () => foreign!())
        return 'second'
      },
    })
    // The gate holds the dependency hook of 'third', so that a newer target supersedes the run in progress.
    const thirdHookGate = deferred()
    let runSignal: AbortSignal | undefined
    const builds = vi.fn()
    provide(app, 'third', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        builds()
        on('dependency-status-change', async ({ decide, signal }) => {
          runSignal = signal
          await thirdHookGate.promise
          return decide.rebuild()
        })
        return 'third'
      },
    })
    await drained(app)
    const { records } = collectRecords(app)

    llm.setStatus('degraded')
    await drained(app)
    expect(stateOf(app, 'second').phase).toBe('failed')
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'second', to: 'failed', decision: 'fail' }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'second', decision: 'fail' }))

    const withdrawal = llm.registration.withdraw()
    await drained(app)
    expect(runSignal?.aborted).toBe(true)

    thirdHookGate.resolve()
    await withdrawal
    expect(builds).toHaveBeenCalledTimes(1)
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'third', hook: 'dependency-status-change', decision: 'rebuild', ignored: true }))
  })

  it('takes the default for a plain object from a dependency hook', async () => {
    const app = createTestContainer()
    const llm = provideWithStatus(app, 'airi.llm')
    const builds = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { llm: llm.registration },
      build: ({ on }) => {
        builds()
        on('dependency-status-change', () => ({ kind: 'rebuild' }) as never)
        return 'speech'
      },
    })
    await start(app)

    llm.setStatus('degraded')
    await drained(app)
    // The default of dependency-status-change is no action. The plain object does not rebuild the service.
    expect(stateOf(app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'degraded' })
    expect(builds).toHaveBeenCalledTimes(1)
  })
})

describe('firstAvailable', () => {
  // Design test 38.
  it('selects the first available provider, moves to the fallback, and moves back when the first returns', async () => {
    const app = createTestContainer()
    const remote = provideWithStatus(app, 'airi.llm.remote')
    const local = provideWithStatus(app, 'airi.llm.local')
    const builds: unknown[] = []
    const moves: { provider: string | undefined, changes: readonly DependencyChange[] }[] = []

    provide(app, 'voice.chat', {
      dependsOn: { llm: firstAvailable(remote.registration, local.registration) },
      build: ({ dependsOn, on }) => {
        builds.push(dependsOn.llm)
        on('dependency-change', ({ dependsOn, changes, decide }) => {
          moves.push({ provider: dependsOn.llm.provider, changes })
          return decide.handled()
        })
        return 'chat'
      },
    })
    provide(app, 'voice.summary', { dependsOn: { llm: firstAvailable('airi.llm.remote', 'airi.llm.local') }, build: ({ dependsOn }) => builds.push(`summary:${String(dependsOn.llm)}`) })
    await start(app)
    expect(builds).toEqual(['airi.llm.remote', 'summary:airi.llm.remote'])

    remote.setStatus('unavailable')
    await drained(app)
    expect(moves.map(move => move.provider)).toEqual(['airi.llm.local'])
    expect(moves[0]!.changes).toEqual([{ key: 'llm', from: expect.objectContaining({ provider: 'airi.llm.remote', status: 'ready' }), to: expect.objectContaining({ provider: 'airi.llm.local' }) }])
    // The selection change is an identity change. Without a handler, the service rebuilds.
    expect(builds).toEqual(['airi.llm.remote', 'summary:airi.llm.remote', 'summary:airi.llm.local'])
    expect(stateOf(app, 'voice.chat').status).toBe('ready')

    remote.setStatus('ready')
    await drained(app)
    expect(moves.map(move => move.provider)).toEqual(['airi.llm.local', 'airi.llm.remote'])
    expect(builds.at(-1)).toBe('summary:airi.llm.remote')
  })

  it('keeps a required fallback pending when no provider is available, and gives undefined to an optional fallback', async () => {
    const app = createTestContainer()
    const seen: unknown[] = []
    provide(app, 'required', { dependsOn: { llm: firstAvailable('a', 'b') }, build: () => 'required' })
    provide(app, 'optional', { dependsOn: { llm: optional(firstAvailable('a', 'b')) }, build: ({ dependsOn }) => seen.push(dependsOn.llm) })
    const started = start(app)
    await drained(app)

    expect(stateOf(app, 'required').phase).toBe('pending')
    expect(stateOf(app, 'optional').phase).toBe('running')
    expect(seen).toEqual([undefined])

    const b = provideWithStatus(app, 'b')
    await started
    expect(seen).toEqual([undefined, { value: 'b', status: 'ready' }])
    b.setStatus('unavailable')
    await drained(app)
    // The only serving candidate stays selected. The running dependent keeps it and reports its status.
    expect(stateOf(app, 'required')).toMatchObject({ phase: 'running', status: 'unavailable' })
  })
})
