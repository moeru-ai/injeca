import type { BuildContext, ObserveRecord, ServiceState } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { BuildAfterDisposeError, InvalidArgumentError, ServiceFailedError, WaitTimeoutError } from '../diagnostics/errors'
import { injeca } from '../index'
import { dispose, firstAvailable, graph, provide, start, timeout } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, trackedController } from '../testing/helpers'
import { observe } from './observe'
import { waitFor, watch } from './watch'

const brief = (state: ServiceState) => `${state.phase ?? '-'}/${state.status ?? '-'}`

describe('watch', () => {
  // Design test 7.
  it('replays the current state at once, and delivers changes in order', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'llm 1')
    await start(app)

    const seen: string[] = []
    const ids = new Set<string | undefined>()
    const stop = watch(app, 'airi.llm', (state) => {
      seen.push(brief(state))
      ids.add(state.instanceId)
    })
    expect(seen).toEqual(['running/ready'])

    await llm.withdraw()
    provide(app, 'airi.llm', () => 'llm 2')
    await drained(app)
    stop()
    provide(app, 'other', () => 'other')
    await drained(app)

    expect(seen).toEqual(['running/ready', 'stopping/-', 'withdrawn/-', 'pending/-', 'building/-', 'starting/-', 'running/ready'])
    // An earlier withdrawn never arrives after a later running.
    expect(seen.lastIndexOf('withdrawn/-')).toBeLessThan(seen.lastIndexOf('running/ready'))
    expect(ids.size).toBe(3)
  })

  it('keeps the order when a callback causes a new change', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'llm')
    const seen: string[] = []
    const other: string[] = []

    watch(app, llm, (state) => {
      seen.push(brief(state))
      if (state.phase === 'running')
        void llm.withdraw()
    })
    watch(app, llm, state => other.push(brief(state)))
    await start(app)
    await drained(app)

    expect(seen).toEqual(['pending/-', 'building/-', 'starting/-', 'running/ready', 'stopping/-', 'withdrawn/-'])
    expect(other).toEqual(seen)
  })

  it('records a callback error in the observe stream and still calls the other callbacks', async () => {
    const app = createTestContainer()
    const { records } = collectRecords(app)
    const error = new Error('callback failed')
    const other = vi.fn()

    watch(app, 'airi.llm', () => {
      throw error
    })
    watch(app, 'airi.llm', other)
    provide(app, 'airi.llm', () => 'llm')
    await start(app)

    expect(other).toHaveBeenCalled()
    expect(records).toContainEqual(expect.objectContaining({ type: 'error', key: 'airi.llm', error }))
  })

  it('does not call a callback after its container is disposed', async () => {
    const root = createTestContainer()
    const child = createTestContainer({ parent: root })
    provide(root, 'airi.llm', () => 'llm')
    const seen: string[] = []
    watch(child, 'airi.llm', state => seen.push(brief(state)))
    await start(root)
    await drained(root)
    const delivered = seen.length

    await dispose(child)
    await dispose(root)
    expect(seen).toHaveLength(delivered)
    expect(() => watch(child, 'airi.llm', () => {})).toThrow(BuildAfterDisposeError)
  })

  it('works with the root container of the global functions', () => {
    const seen: ServiceState[] = []
    watch(injeca.getContainer(), 'not-provided', state => seen.push(state))()
    expect(seen).toEqual([{ phase: undefined, status: undefined, instanceId: undefined }])
  })
})

describe('waitFor', () => {
  it('resolves when the key becomes available, and when it has the given status', async () => {
    const app = createTestContainer()
    let setStatus: BuildContext['setStatus'] = () => {}
    const available = waitFor(app, 'airi.llm')
    const degraded = waitFor(app, 'airi.llm', { status: 'degraded' })
    await start(app)

    provide(app, 'airi.llm', (context) => {
      setStatus = context.setStatus
      return 'llm'
    })
    await expect(available).resolves.toMatchObject({ phase: 'running', status: 'ready' })

    setStatus('degraded', 'fallback voice')
    await expect(degraded).resolves.toMatchObject({ phase: 'running', status: 'degraded', reason: 'fallback voice' })

    setStatus('unavailable')
    const back = waitFor(app, 'airi.llm')
    await drained(app)
    let resolved = false
    void back.then(() => {
      resolved = true
    })
    await drained(app)
    expect(resolved).toBe(false)
    setStatus('ready')
    await expect(back).resolves.toMatchObject({ status: 'ready' })
  })

  it('rejects with wait-timeout when a timeout signal on the container clock aborts, and has no built-in timeout', async () => {
    const { clock, advance, pending } = manualClock()
    const app = createTestContainer({ clock })

    const forever = waitFor(app, 'missing')
    expect(pending()).toBe(0)

    const timed = waitFor(app, 'missing', { signal: timeout(app, 50) }).catch((error: unknown) => error)
    advance(50)
    expect(await timed).toBeInstanceOf(WaitTimeoutError)
    expect(await timed).toMatchObject({ code: 'wait-timeout', cause: expect.objectContaining({ name: 'TimeoutError' }) })
    expect(pending()).toBe(0)

    // `AbortSignal.timeout()` has the same reason name, so it also gives `wait-timeout`.
    const native = new AbortController()
    const nativeWait = waitFor(app, 'missing', { signal: native.signal }).catch((error: unknown) => error)
    native.abort(new DOMException('native', 'TimeoutError'))
    expect(await nativeWait).toBeInstanceOf(WaitTimeoutError)

    await dispose(app)
    await expect(forever).rejects.toBeInstanceOf(BuildAfterDisposeError)
  })

  it('rejects with the abort reason, at once for an aborted signal', async () => {
    const app = createTestContainer()
    const { controller, signal, listeners } = trackedController()
    const reason = new Error('cancelled')
    const waiting = waitFor(app, 'missing', { signal })
    expect(listeners()).toBe(1)

    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    await expect(waitFor(app, 'missing', { signal })).rejects.toBe(reason)
  })

  it('removes its abort listener when it matches', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    await start(app)
    const { signal, listeners } = trackedController()

    await expect(waitFor(app, 'airi.llm', { signal })).resolves.toMatchObject({ phase: 'running' })
    expect(listeners()).toBe(0)
  })

  it('rejects invalid options', () => {
    const app = createTestContainer()
    expect(() => waitFor(app, 'airi.llm', { status: 'broken' as 'ready' })).toThrow(InvalidArgumentError)
    expect(() => waitFor(app, 'airi.llm', { signal: 50 as unknown as AbortSignal })).toThrow(InvalidArgumentError)
  })
})

describe('watch and waitFor of a perConsumer key (B2)', () => {
  it('demands the consumer service of the container, so they report its real state', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const builds: unknown[] = []
    provide(root, 'host.client', { perConsumer: true, build: ({ consumer }) => builds.push(consumer) })
    await start(root)
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'e' } })
    await start(extension)

    const seen: string[] = []
    const stop = watch(extension, 'host.client', state => seen.push(brief(state)))
    await drained(root)
    expect(seen).toEqual(['pending/-', 'building/-', 'starting/-', 'running/ready'])
    expect(builds).toEqual([{ kind: 'extension', id: 'e' }])
    stop()

    const other = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'other' } })
    await start(other)
    await expect(waitFor(other, 'host.client', { signal: timeout(other, 1_000) })).resolves.toMatchObject({ phase: 'running', status: 'ready' })
    expect(builds).toEqual([{ kind: 'extension', id: 'e' }, { kind: 'extension', id: 'other' }])
  })

  it('ends the demand with the subscription in a container that is not started', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    provide(root, 'host.client', { perConsumer: true, build: ({ consumer }) => consumer })
    await start(root)
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'e' } })

    const seen: string[] = []
    const stop = watch(extension, 'host.client', state => seen.push(brief(state)))
    await drained(root)
    expect(seen.at(-1)).toBe('running/ready')

    stop()
    await drained(root)
    // Nothing else demands the consumer service, and its container is not started. So it stops.
    expect(graph(extension).services().map(service => `${service.key}:${service.phase}`)).toEqual(['host.client:pending'])
  })
})

describe('waitFor of a failed service (B3)', () => {
  it('rejects with service-failed and the failure as its cause', async () => {
    const app = createTestContainer()
    const error = new Error('build failed')
    provide(app, 'broken', () => {
      throw error
    })
    void start(app).catch(() => {})
    await drained(app)

    const failed = await waitFor(app, 'broken').catch((reason: unknown) => reason)
    expect(failed).toBeInstanceOf(ServiceFailedError)
    expect(failed).toMatchObject({ code: 'service-failed', key: 'broken', cause: error })
  })

  it('rejects when the service waits for a required provider that failed', async () => {
    const app = createTestContainer()
    const error = new Error('llm failed')
    const llm = provide(app, 'airi.llm', () => {
      throw error
    })
    provide(app, 'voice.speech', { dependsOn: { llm }, build: () => 'speech' })
    const waiting = waitFor(app, 'voice.speech').catch((reason: unknown) => reason)
    void start(app).catch(() => {})

    expect(await waiting).toMatchObject({ code: 'service-failed', key: 'voice.speech', cause: error })
  })
})

describe('observe', () => {
  it('replays the current state of all services, with child containers, then records each transition', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const child = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'voice' } })
    const llm = provide(root, 'airi.llm', () => 'llm')
    provide(child, 'voice.speech', { dependsOn: { llm }, build: () => 'speech' })
    provide(root, 'idle', { dependsOn: { missing: 'missing' }, build: () => 'idle' })
    // 'idle' waits for a missing key, so start(root) does not resolve.
    void start(root)
    await start(child)
    await drained(root)
    const llmId = (() => {
      let id: string | undefined
      watch(root, llm, (state) => {
        id = state.instanceId
      })()
      return id
    })()

    const records: ObserveRecord[] = []
    const stop = observe(root, entry => records.push(entry))
    expect(records).toEqual([
      { type: 'phase', key: 'airi.llm', owner: { kind: 'host' }, instanceId: llmId, from: undefined, to: 'running' },
      { type: 'status', key: 'airi.llm', owner: { kind: 'host' }, instanceId: llmId, from: undefined, to: 'ready' },
      { type: 'phase', key: 'idle', owner: { kind: 'host' }, instanceId: undefined, from: undefined, to: 'pending' },
      expect.objectContaining({ type: 'phase', key: 'voice.speech', owner: { kind: 'extension', id: 'voice' }, to: 'running' }),
      expect.objectContaining({ type: 'status', key: 'voice.speech', to: 'ready' }),
    ])

    records.length = 0
    await llm.withdraw()
    // The provider enters stopping first. It waits there until its holder releases it.
    expect(records.map(entry => entry.type === 'phase' ? `${entry.key}: ${entry.from} -> ${entry.to}` : entry.type)).toEqual([
      'airi.llm: running -> stopping',
      'voice.speech: running -> stopping',
      'voice.speech: stopping -> pending',
      'airi.llm: stopping -> withdrawn',
    ])
    expect(records[0]).toMatchObject({ reason: 'The service was withdrawn.' })
    expect(records[1]).toMatchObject({ reason: 'A required dependency was withdrawn.' })

    stop()
    provide(root, 'late', () => 'late')
    await drained(root)
    expect(records).toHaveLength(4)
  })

  it('records status changes with their cause, and decisions with their kind', async () => {
    const app = createTestContainer()
    let setStatus: BuildContext['setStatus'] = () => {}
    const remote = provide(app, 'airi.llm.remote', (context) => {
      setStatus = context.setStatus
      return 'remote'
    })
    provide(app, 'airi.llm.local', () => 'local')
    provide(app, 'voice.speech', {
      dependsOn: { llm: remote },
      build: ({ on }) => {
        on('dependency-status-change', ({ decide }) => decide.handled({ reason: 'keep serving' }))
        return 'speech'
      },
    })
    provide(app, 'voice.chat', {
      dependsOn: { llm: firstAvailable('airi.llm.remote', 'airi.llm.local') },
      build: ({ on }) => {
        on('dependency-change', ({ decide }) => decide.rebuild({ reason: 'new model' }))
        return 'chat'
      },
    })
    await start(app)
    const { records } = collectRecords(app)
    records.length = 0

    setStatus('unavailable', 'offline')
    await drained(app)

    expect(records).toContainEqual(expect.objectContaining({ type: 'status', key: 'airi.llm.remote', from: 'ready', to: 'unavailable', reason: 'offline' }))
    expect(records).toContainEqual(expect.objectContaining({
      type: 'status',
      key: 'voice.speech',
      from: 'ready',
      to: 'unavailable',
      cause: expect.objectContaining({ key: 'airi.llm.remote', status: 'unavailable', reason: 'offline' }),
    }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'voice.speech', hook: 'dependency-status-change', decision: 'handled', attempt: 1, ignored: false, reason: 'keep serving' }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'voice.chat', hook: 'dependency-change', decision: 'rebuild', reason: 'new model' }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'voice.chat', from: 'running', to: 'stopping', decision: 'rebuild', reason: 'new model' }))
  })

  it('does not send an observe callback error back to that callback, and stops at disposal', async () => {
    const app = createTestContainer()
    const failing = vi.fn((_entry: ObserveRecord) => {
      throw new Error('observer failed')
    })
    const records: ObserveRecord[] = []
    observe(app, failing)
    observe(app, entry => records.push(entry))

    // The gate holds the start hook of llm, so that the transitions arrive after the observers subscribe.
    const llmStartGate = deferred()
    provide(app, 'airi.llm', ({ on }) => {
      on('start', () => llmStartGate.promise)
      return 'llm'
    })
    void start(app)
    await drained(app)
    llmStartGate.resolve()
    await drained(app)

    expect(records.filter(entry => entry.type === 'error')).not.toHaveLength(0)
    expect(failing.mock.calls.every(([entry]) => entry.type !== 'error')).toBe(true)

    await dispose(app)
    const count = records.length
    expect(() => observe(app, () => {})).toThrow(BuildAfterDisposeError)
    expect(records).toHaveLength(count)
  })
})
