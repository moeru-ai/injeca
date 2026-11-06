import type { BuildContext, HookHandler } from '../types'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BuildAfterDisposeError,
  DuplicateServiceError,
  HookOutsideBuildError,
  InvalidArgumentError,
  ReentrantDisposeError,
  StartTimeoutError,
} from '../diagnostics/errors'
import { defineKey, dispose, effect, invoke, optional, provide, resolve, start, stop, timeout } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, phaseOf, trackedController } from '../testing/helpers'

describe('start and stop', () => {
  it('builds a service only after its required dependencies run', async () => {
    const app = createTestContainer()
    // The gate holds the start hook of llm, so that the test can check the phases while llm is starting.
    const llmStartGate = deferred()
    const speechBuild = vi.fn(({ dependsOn }: { dependsOn: { llm: { id: string } } }) => ({ llm: dependsOn.llm }))

    // The dependent comes first. It stays pending until the provider runs.
    const llmKey = defineKey<{ id: string }>('airi.llm')
    provide(app, 'voice.speech', {
      dependsOn: { llm: llmKey },
      build: speechBuild,
    })
    provide(app, llmKey, {
      build: ({ on }) => {
        on('start', () => llmStartGate.promise)
        return { id: 'llm' }
      },
    })

    const started = start(app)
    await drained(app)
    expect(phaseOf(app, llmKey)).toBe('starting')
    expect(speechBuild).not.toHaveBeenCalled()

    // Open the gate: the start hook of llm ends, llm runs, and speech builds.
    llmStartGate.resolve()
    await started
    expect(phaseOf(app, 'voice.speech')).toBe('running')
    expect(speechBuild).toHaveBeenCalledTimes(1)
    expect(speechBuild.mock.calls[0]?.[0].dependsOn.llm).toEqual({ id: 'llm' })
  })

  it('does not build before start(), and runs an invocation after start()', async () => {
    const app = createTestContainer()
    const build = vi.fn(() => 'config')
    const callback = vi.fn()

    const config = provide(app, 'config', build)
    invoke(app, { dependsOn: { config }, callback })
    await drained(app)
    expect(build).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()

    await start(app)
    expect(build).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]?.[0]).toEqual({ config: 'config' })
  })

  it('gives an invocation on, effect, and signal', async () => {
    const app = createTestContainer()
    const order: string[] = []
    const config = provide(app, 'config', () => 'config')

    invoke(app, {
      dependsOn: { config },
      callback: (_, { on, effect, signal }) => {
        expect(signal.aborted).toBe(false)
        on('start', () => {
          order.push('start')
        })
        on('stop', () => {
          order.push('stop')
        })
        // The setup runs at once. The disposer runs at instance disposal, after the stop hooks.
        const disposeEffect = () => {
          order.push('effect')
        }
        const setupEffect = () => disposeEffect
        effect(setupEffect)
      },
    })

    await start(app)
    await stop(app)
    expect(order).toEqual(['start', 'stop', 'effect'])
  })

  it('stops dependents before their providers, and keeps the registrations for a later start()', async () => {
    const app = createTestContainer()
    const order: string[] = []
    const builds = vi.fn()
    const stopHook = (name: string): HookHandler<'stop'> => () => {
      order.push(name)
    }

    const db = provide(app, 'db', ({ on }) => {
      builds('db')
      on('stop', stopHook('db'))
      return 'db'
    })
    const api = provide(app, 'api', {
      dependsOn: { db },
      build: ({ on }) => {
        builds('api')
        on('stop', stopHook('api'))
        return 'api'
      },
    })
    invoke(app, {
      dependsOn: { api },
      callback: (_, { on }) => on('stop', stopHook('invocation')),
    })

    await start(app)
    await stop(app)
    expect(order).toEqual(['invocation', 'api', 'db'])
    expect(phaseOf(app, db)).toBe('pending')

    await start(app)
    expect(builds).toHaveBeenCalledTimes(4)
    expect(phaseOf(app, api)).toBe('running')
  })

  // Design test 32.
  it('builds and starts a service that is provided after start()', async () => {
    const app = createTestContainer()
    const startHook = vi.fn()
    const config = provide(app, 'config', () => 'config')
    await start(app)

    provide(app, 'late', {
      dependsOn: { config },
      build: ({ on, dependsOn }) => {
        on('start', startHook)
        return `late ${dependsOn.config}`
      },
    })
    await drained(app)

    expect(phaseOf(app, 'late')).toBe('running')
    expect(startHook).toHaveBeenCalledTimes(1)
    await expect(resolve(app, { late: 'late' })).resolves.toEqual({ late: 'late config' })
  })

  // Design test 34.
  it('keeps a dependent of a defineKey key pending until a provider registers, then starts it', async () => {
    const app = createTestContainer()
    const ttsKey = defineKey<{ speak: () => string }>('airi.tts')
    const callback = vi.fn()

    const speech = provide(app, 'voice.speech', {
      dependsOn: { tts: ttsKey },
      build: ({ dependsOn }) => dependsOn.tts.speak(),
    })
    invoke(app, { dependsOn: { speech }, callback })

    let started = false
    const starting = start(app).then(() => {
      started = true
    })
    await drained(app)
    expect(phaseOf(app, speech)).toBe('pending')
    expect(callback).not.toHaveBeenCalled()
    expect(started).toBe(false)

    provide(app, ttsKey, () => ({ speak: () => 'hello' }))
    await starting
    expect(phaseOf(app, speech)).toBe('running')
    expect(callback).toHaveBeenCalledWith({ speech: 'hello' }, expect.anything())
  })

  // Design test 33. reconciler/build.test.ts also covers it with the hook context.
  it('runs an invocation again when a required dependency gets a new instance', async () => {
    const app = createTestContainer()
    const seen: string[] = []
    const stopHook = vi.fn()

    const first = provide(app, 'config', () => 'first')
    invoke(app, {
      dependsOn: { config: first },
      callback: ({ config }, { on }) => {
        seen.push(config)
        on('stop', stopHook)
      },
    })
    await start(app)

    await first.withdraw()
    expect(stopHook).toHaveBeenCalledTimes(1)
    provide(app, 'config', () => 'second')
    await drained(app)

    expect(seen).toEqual(['first', 'second'])
  })

  it('rejects start() with the build error, and tries the failed service again on the next start()', async () => {
    const app = createTestContainer()
    const error = new Error('boom')
    const disposer = vi.fn()
    let fail = true

    provide(app, 'config', ({ effect }) => {
      effect(() => disposer)
      if (fail)
        throw error
      return 'config'
    })

    await expect(start(app)).rejects.toBe(error)
    expect(phaseOf(app, 'config')).toBe('failed')
    expect(disposer).toHaveBeenCalledTimes(1)

    fail = false
    await start(app)
    expect(phaseOf(app, 'config')).toBe('running')
  })

  it('rejects start() with an AggregateError for more than one failure', async () => {
    const app = createTestContainer()
    provide(app, 'a', () => {
      throw new Error('a')
    })
    provide(app, 'b', () => {
      throw new Error('b')
    })

    const result = await start(app).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors.map(error => (error as Error).message)).toEqual(['a', 'b'])
  })

  it('rejects stop() with the stop hook errors', async () => {
    const app = createTestContainer()
    const error = new Error('stop failed')
    provide(app, 'config', ({ on }) => {
      on('stop', ({ decide }) => decide.fail(error))
      return 'config'
    })

    await start(app)
    await expect(stop(app)).rejects.toBe(error)
  })
})

describe('registrations', () => {
  it('replaces the first registration with a second provide of the same name before start()', async () => {
    const app = createTestContainer()
    const first = provide(app, 'config', () => 'first')
    provide(app, 'config', () => 'second')

    await expect(first.withdraw()).resolves.toBe(false)
    await expect(resolve(app, { config: 'config' })).resolves.toEqual({ config: 'second' })
  })

  it('records registration-replaced for a second provide of the same name before start(), and runs no hook', async () => {
    const app = createTestContainer({ owner: { kind: 'host' } })
    const firstStart = vi.fn()
    provide(app, 'config', ({ on }) => {
      on('start', firstStart)
      return 'first'
    })
    const { records } = collectRecords(app)

    provide(app, 'config', () => 'second')
    await drained(app)

    expect(records.filter(entry => entry.type === 'registration-replaced')).toEqual([{
      type: 'registration-replaced',
      key: 'config',
      owner: { kind: 'host' },
      instanceId: undefined,
      reason: 'A second provide of \'config\' replaced the registration before start().',
    }])
    expect(firstStart).not.toHaveBeenCalled()
  })

  it('throws duplicate-service for a second provide of the same name after start()', async () => {
    const app = createTestContainer()
    const first = provide(app, 'config', () => 'first')
    await start(app)

    expect(() => provide(app, 'config', () => 'second')).toThrow(DuplicateServiceError)

    await first.withdraw()
    provide(app, 'config', () => 'second')
    await expect(resolve(app, { config: 'config' })).resolves.toEqual({ config: 'second' })
  })

  // Design test 1.
  it('does not let a stale registration withdraw a newer service', async () => {
    const app = createTestContainer()
    await start(app)

    const stale = provide(app, 'airi.llm', () => 'first')
    await drained(app)
    await expect(stale.withdraw()).resolves.toBe(true)

    provide(app, 'airi.llm', () => 'second')
    await drained(app)

    await expect(stale.withdraw()).resolves.toBe(false)
    await drained(app)
    expect(phaseOf(app, 'airi.llm')).toBe('running')
  })

  it('withdraws dependents first, and rebuilds them when the provider returns', async () => {
    const app = createTestContainer()
    const order: string[] = []
    const stopHook = (name: string): HookHandler<'stop'> => () => {
      order.push(name)
    }

    const llm = provide(app, 'airi.llm', ({ on }) => {
      on('stop', stopHook('llm'))
      return 'llm'
    })
    const speech = provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('stop', stopHook('speech'))
        return 'speech'
      },
    })
    provide(app, 'voice.summary', {
      dependsOn: { speech },
      build: ({ on }) => {
        on('stop', stopHook('summary'))
        return 'summary'
      },
    })
    await start(app)

    await expect(llm.withdraw()).resolves.toBe(true)
    expect(order).toEqual(['summary', 'speech', 'llm'])
    expect(phaseOf(app, llm)).toBeUndefined()
    expect(phaseOf(app, speech)).toBe('pending')
    expect(phaseOf(app, 'voice.summary')).toBe('pending')

    provide(app, 'airi.llm', () => 'llm 2')
    await drained(app)
    expect(phaseOf(app, speech)).toBe('running')
    expect(phaseOf(app, 'voice.summary')).toBe('running')
  })

  // Design test 4.
  it('lets a provider wait for its holders before its own stop runs', async () => {
    const app = createTestContainer()
    // The gate holds the stop hook of api, so that the test can check that db waits for its holder.
    const apiStopGate = deferred()
    const dbStop = vi.fn()
    const queriesDuringStop: string[] = []

    const db = provide(app, 'airi.db', ({ on }) => {
      on('stop', dbStop)
      return { query: () => 'row' }
    })
    provide(app, 'airi.api', {
      dependsOn: { db },
      build: ({ dependsOn, on }) => {
        on('stop', async () => {
          await apiStopGate.promise
          // A holder can use the provider during its own teardown.
          queriesDuringStop.push(dependsOn.db.query())
        })
        return 'api'
      },
    })
    await start(app)

    const withdrawal = db.withdraw()
    await drained(app)
    expect(dbStop).not.toHaveBeenCalled()

    apiStopGate.resolve()
    await expect(withdrawal).resolves.toBe(true)
    expect(queriesDuringStop).toEqual(['row'])
    expect(dbStop).toHaveBeenCalledTimes(1)
  })

  // Design test 5.
  it('discards a build whose required dependency is withdrawn during the build, and aborts its signal', async () => {
    const app = createTestContainer()
    const build = deferred<string>()
    const startHook = vi.fn()
    const disposer = vi.fn()
    let signal: AbortSignal | undefined

    const llm = provide(app, 'airi.llm', () => 'llm')
    const speech = provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: (context) => {
        signal = context.signal
        context.on('start', startHook)
        context.effect(() => disposer)
        return build.promise
      },
    })
    void start(app)
    await drained(app)
    expect(phaseOf(app, speech)).toBe('building')

    const withdrawal = llm.withdraw()
    await drained(app)
    expect(signal?.aborted).toBe(true)

    build.resolve('late')
    await withdrawal
    expect(startHook).not.toHaveBeenCalled()
    expect(disposer).toHaveBeenCalledTimes(1)
    expect(phaseOf(app, speech)).toBe('pending')
  })

  it('withdraws an invocation with its handle', async () => {
    const app = createTestContainer()
    const stopHook = vi.fn()
    const handle = invoke(app, (_, { on }) => on('stop', stopHook))
    await start(app)

    await expect(handle.withdraw()).resolves.toBe(true)
    await expect(handle.withdraw()).resolves.toBe(false)
    expect(stopHook).toHaveBeenCalledTimes(1)
  })
})

describe('optional dependencies', () => {
  it('gives undefined for a missing optional dependency and a wrapped value for a present one', async () => {
    const app = createTestContainer()
    const ttsKey = defineKey<string>('airi.tts')
    const seen: unknown[] = []

    provide(app, 'a', {
      dependsOn: { tts: optional(ttsKey) },
      build: ({ dependsOn }) => {
        seen.push(dependsOn.tts)
        return 'a'
      },
    })
    await start(app)
    expect(seen).toEqual([undefined])

    provide(app, ttsKey, () => 'voice')
    await drained(app)
    // The optional dependency appears. Without a handler, 'a' rebuilds.
    expect(seen).toEqual([undefined, { value: 'voice', status: 'ready' }])
  })

  it('accepts a name for an optional dependency', async () => {
    const app = createTestContainer()
    provide(app, 'config', () => 'config')

    await expect(resolve(app, { config: optional('config'), missing: optional('missing') })).resolves.toEqual({
      config: { value: 'config', status: 'ready' },
      missing: undefined,
    })
  })
})

describe('resolve', () => {
  it('waits for a starting optional provider, and gives undefined for a failed one', async () => {
    const app = createTestContainer()
    // The gate holds the start hook of 'slow', so that resolve() sees a provider that is still starting.
    const slowStartGate = deferred()
    provide(app, 'slow', ({ on }) => {
      on('start', () => slowStartGate.promise)
      return 'slow'
    })
    provide(app, 'broken', () => {
      throw new Error('broken')
    })

    const resolved = resolve(app, { slow: optional('slow'), broken: optional('broken') })
    await drained(app)
    slowStartGate.resolve()

    await expect(resolved).resolves.toEqual({ slow: { value: 'slow', status: 'ready' }, broken: undefined })
  })

  it('resolves dependencies without start(), and builds each service once', async () => {
    const app = createTestContainer()
    const database = provide(app, 'database', () => ({ url: 'memory://' }))
    const modelBuild = vi.fn(({ dependsOn }: BuildContext<{ database: { url: string } }>) => ({ dbUrl: dependsOn.database.url, name: 'User' }))
    const model = provide(app, 'model', { dependsOn: { database }, build: modelBuild })
    const controller = provide(app, 'controller', {
      dependsOn: { model },
      build: ({ dependsOn }) => `handling ${dependsOn.model.name} from ${dependsOn.model.dbUrl}`,
    })

    const resolved = await resolve(app, { controller })
    expect(resolved.controller).toBe('handling User from memory://')
    expect(modelBuild).toHaveBeenCalledTimes(1)
    expect(Object.keys(modelBuild.mock.calls[0]![0].dependsOn)).toHaveLength(1)
  })

  it('rejects with the build error of a required dependency', async () => {
    const app = createTestContainer()
    const error = new Error('boom')
    const database = provide(app, 'database', () => {
      throw error
    })
    const model = provide(app, 'model', { dependsOn: { database }, build: () => 'model' })

    await expect(resolve(app, { model })).rejects.toBe(error)
  })

  it('rejects when the container is disposed while resolve waits', async () => {
    const app = createTestContainer()
    const pending = resolve(app, { missing: 'missing' })

    await dispose(app)
    await expect(pending).rejects.toBeInstanceOf(BuildAfterDisposeError)
  })
})

describe('build context and hooks', () => {
  it('gives the 0.2 fields and the new fields to build', async () => {
    const app = createTestContainer()
    let context: BuildContext | undefined

    provide(app, 'config', (buildContext) => {
      context = buildContext
      return 'config'
    })
    await start(app)

    expect(context?.container).toBe(app)
    expect(context?.name).toBe('config')
    expect(context?.dependsOn).toEqual({})
    expect(context?.instanceId).toBeTypeOf('string')
    expect(context?.signal).toBeInstanceOf(AbortSignal)
  })

  // Design test 10.
  it('throws hook-outside-build when on is called after build returns', async () => {
    const app = createTestContainer()
    let syncOn: BuildContext['on'] | undefined
    let asyncOn: BuildContext['on'] | undefined
    const lateStart = vi.fn()

    provide(app, 'sync', ({ on }) => {
      syncOn = on
      return 'sync'
    })
    provide(app, 'async', async ({ on }) => {
      asyncOn = on
      await Promise.resolve()
      // Still valid: the async build has not settled.
      on('start', lateStart)
      return 'async'
    })
    await start(app)

    expect(() => syncOn?.('start', () => {})).toThrow(HookOutsideBuildError)
    expect(() => asyncOn?.('stop', () => {})).toThrow(HookOutsideBuildError)
    expect(lateStart).toHaveBeenCalledTimes(1)
  })

  it('runs start hooks in order and stop hooks in reverse order, then effects in reverse order', async () => {
    const app = createTestContainer()
    const order: string[] = []

    const registration = provide(app, 'airi.llm', ({ on, effect }) => {
      on('start', () => {
        order.push('start 1')
      })
      on('start', () => {
        order.push('start 2')
      })
      on('stop', () => {
        order.push('stop 1')
      })
      on('stop', () => {
        order.push('stop 2')
      })
      // Each setup runs at once. The disposers run at instance disposal, after the stop hooks, in reverse order.
      const disposeFirstEffect = () => {
        order.push('effect 1')
      }
      const disposeSecondEffect = () => {
        order.push('effect 2')
      }
      const setupFirstEffect = () => disposeFirstEffect
      const setupSecondEffect = () => disposeSecondEffect
      effect(setupFirstEffect)
      effect(setupSecondEffect)
      return 'llm'
    })
    await start(app)
    await registration.withdraw()

    expect(order).toEqual(['start 1', 'start 2', 'stop 2', 'stop 1', 'effect 2', 'effect 1'])
  })

  // Design test 11.
  it('takes the default of the hook when a hook returns a plain object', async () => {
    const app = createTestContainer()

    provide(app, 'start', ({ on }) => {
      on('start', () => ({ kind: 'fail' }) as unknown as ReturnType<HookHandler<'start'>>)
      return 'start'
    })
    const stopRegistration = provide(app, 'stop', ({ on }) => {
      on('stop', () => ({ kind: 'fail' }) as unknown as ReturnType<HookHandler<'stop'>>)
      return 'stop'
    })

    await start(app)
    expect(phaseOf(app, 'start')).toBe('running')
    expect(phaseOf(app, 'stop')).toBe('running')
    await expect(stopRegistration.withdraw()).resolves.toBe(true)
  })

  // Design test 11.
  it('reaches running when a start hook returns a server object', async () => {
    const app = createTestContainer()
    const server = { close: () => {} }
    const listen = () => server

    provide(app, 'http.server', ({ on }) => {
      on('start', () => listen())
      return 'server'
    })

    await start(app)
    expect(phaseOf(app, 'http.server')).toBe('running')
  })

  // Design test 11.
  it('reaches running when an async start hook resolves to a value that is not a decision', async () => {
    const app = createTestContainer()

    provide(app, 'http.server', ({ on }) => {
      on('start', async () => 8080)
      return 'server'
    })

    await start(app)
    expect(phaseOf(app, 'http.server')).toBe('running')
  })

  it('runs stop hooks and moves to failed when start returns fail', async () => {
    const app = createTestContainer()
    const stopHook = vi.fn()
    const error = new Error('no network')

    provide(app, 'airi.llm', ({ on }) => {
      on('start', ({ decide }) => decide.fail(error))
      on('stop', stopHook)
      return 'llm'
    })

    await expect(start(app)).rejects.toBe(error)
    expect(phaseOf(app, 'airi.llm')).toBe('failed')
    expect(stopHook).toHaveBeenCalledTimes(1)
  })

  it('treats a thrown start error as fail', async () => {
    const app = createTestContainer()
    const error = new Error('boom')
    provide(app, 'airi.llm', ({ on }) => {
      on('start', () => {
        throw error
      })
      return 'llm'
    })

    await expect(start(app)).rejects.toBe(error)
  })

  it('parks the service when start returns stop, and builds it again only in a new epoch', async () => {
    const app = createTestContainer()
    const build = vi.fn(() => 'speech')
    const stopHook = vi.fn()
    let stopOnStart = true

    const llm = provide(app, 'airi.llm', () => 'llm')
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('start', ({ decide }) => stopOnStart ? decide.stop({ reason: 'disabled' }) : undefined)
        on('stop', stopHook)
        return build()
      },
    })
    void start(app)
    await drained(app)
    await drained(app)

    expect(phaseOf(app, 'voice.speech')).toBe('pending')
    expect(build).toHaveBeenCalledTimes(1)
    expect(stopHook).toHaveBeenCalledTimes(1)

    // A new dependency instance is a new epoch. The service builds again.
    stopOnStart = false
    await llm.withdraw()
    provide(app, 'airi.llm', () => 'llm 2')
    await drained(app)
    expect(phaseOf(app, 'voice.speech')).toBe('running')
    expect(build).toHaveBeenCalledTimes(2)
  })

  describe('timeouts', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('rejects start() with start-timeout when a timeout signal aborts, and explains a missing provider and a failed dependency', async () => {
      vi.useFakeTimers()
      const app = createTestContainer()
      const error = new Error('broken')
      const ttsKey = defineKey<string>('airi.tts')

      provide(app, 'voice.speech', { dependsOn: { tts: ttsKey }, build: ({ dependsOn }) => dependsOn.tts })
      const broken = provide(app, 'broken', () => {
        throw error
      })
      provide(app, 'needs-broken', { dependsOn: { broken }, build: () => 'never' })
      // Without work in progress, a failure rejects start() at once. A start hook that never settles keeps it waiting until the timeout.
      provide(app, 'hanging', ({ on }) => {
        on('start', () => new Promise<void>(() => {}))
        return 'hanging'
      })

      const result = start(app, { signal: timeout(app, 1_000) }).catch((reason: unknown) => reason)
      await vi.advanceTimersByTimeAsync(999)
      await vi.advanceTimersByTimeAsync(1)

      const failure = await result
      expect(failure).toBeInstanceOf(StartTimeoutError)
      expect(failure).toMatchObject({ code: 'start-timeout' })
      const explanations = (failure as StartTimeoutError).explanations
      expect(explanations).toEqual([
        expect.objectContaining({ name: 'voice.speech', phase: 'pending', blockers: [{ kind: 'missing-provider', dependency: 'tts', key: 'airi.tts' }] }),
        expect.objectContaining({ name: 'broken', phase: 'failed', blockers: [{ kind: 'failed', error }] }),
        expect.objectContaining({ name: 'needs-broken', phase: 'pending', blockers: [{ kind: 'failed-dependency', dependency: 'broken', key: 'broken', error }] }),
        expect.objectContaining({ name: 'hanging', phase: 'starting', blockers: [] }),
      ])
      expect((failure as Error).message).toContain('no provider for \'airi.tts\'')
    })

    it('explains a pending dependency', async () => {
      vi.useFakeTimers()
      const app = createTestContainer()
      const slow = provide(app, 'slow', { dependsOn: { missing: 'missing' }, build: () => 'slow' })
      invoke(app, { dependsOn: { slow }, callback: () => {} })

      const result = start(app, { signal: timeout(app, 10) }).catch((reason: unknown) => reason)
      await vi.advanceTimersByTimeAsync(10)

      const explanations = ((await result) as StartTimeoutError).explanations
      expect(explanations[1]).toMatchObject({ kind: 'invocation', blockers: [{ kind: 'pending-dependency', dependency: 'slow', key: 'slow', phase: 'pending' }] })
    })

    it('keeps waiting without a signal when a provider is missing', async () => {
      vi.useFakeTimers()
      const app = createTestContainer()
      provide(app, 'voice.speech', { dependsOn: { tts: 'airi.tts' }, build: () => 'speech' })

      let outcome = 'waiting'
      void start(app).then(() => {
        outcome = 'resolved'
      }, () => {
        outcome = 'rejected'
      })
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(outcome).toBe('waiting')

      provide(app, 'airi.tts', () => 'tts')
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toBe('resolved')
    })

    it('rejects an invalid signal and an invalid timeout', () => {
      expect(() => start(createTestContainer(), { signal: 'soon' as unknown as AbortSignal })).toThrow(InvalidArgumentError)
      expect(() => timeout(createTestContainer(), -1)).toThrow(InvalidArgumentError)
    })

    // Design test 20.
    it('waits for a start hook without a timeout until it settles', async () => {
      vi.useFakeTimers()
      const app = createTestContainer()
      // The gate holds the start hook of llm for a full day of fake time.
      const llmStartGate = deferred()

      provide(app, 'airi.llm', ({ on }) => {
        on('start', () => llmStartGate.promise)
        return 'llm'
      })
      let started = false
      void start(app).then(() => {
        started = true
      })
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(phaseOf(app, 'airi.llm')).toBe('starting')
      expect(started).toBe(false)

      llmStartGate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(phaseOf(app, 'airi.llm')).toBe('running')
      expect(started).toBe(true)
    })
  })
})

describe('child containers', () => {
  it('resolves keys from ancestors and not from siblings', async () => {
    const root = createTestContainer()
    const left = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'left' } })
    const right = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'right' } })

    const llm = provide(root, 'airi.llm', () => 'llm')
    const local = provide(left, 'local', () => 'local')
    provide(right, 'from-ancestor', { dependsOn: { llm }, build: ({ dependsOn }) => dependsOn.llm })
    provide(right, 'from-sibling', { dependsOn: { local }, build: ({ dependsOn }) => dependsOn.local })
    void start(root)
    void start(left)
    void start(right)
    await drained(root)

    expect(phaseOf(right, 'from-ancestor')).toBe('running')
    expect(phaseOf(right, 'from-sibling')).toBe('pending')
    expect(right.parent).toBe(root)
    expect(right.owner).toEqual({ kind: 'extension', id: 'right' })
    expect(Object.isFrozen(right.owner)).toBe(true)
  })

  it('does not build a child under a started parent until start(child), then converges a later provide at once', async () => {
    const root = createTestContainer()
    const build = vi.fn(() => 'first')
    const callback = vi.fn()
    await start(root)

    const child = createTestContainer({ parent: root })
    const first = provide(child, 'first', build)
    invoke(child, { dependsOn: { first }, callback })
    await drained(root)
    expect(build).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()

    await start(child)
    expect(phaseOf(child, first)).toBe('running')
    expect(callback).toHaveBeenCalledTimes(1)

    provide(child, 'late', () => 'late')
    await drained(root)
    expect(phaseOf(child, 'late')).toBe('running')
  })

  it('restarts only the children that were started when start(parent) follows stop(parent)', async () => {
    const root = createTestContainer()
    const started = createTestContainer({ parent: root })
    const idle = createTestContainer({ parent: root })
    const builds: string[] = []

    provide(root, 'root', () => builds.push('root'))
    provide(started, 'started', () => builds.push('started'))
    provide(idle, 'idle', () => builds.push('idle'))

    await start(root)
    await start(started)
    expect(builds).toEqual(['root', 'started'])

    await stop(root)
    expect(phaseOf(root, 'root')).toBe('pending')
    expect(phaseOf(started, 'started')).toBe('pending')

    await start(root)
    expect(builds).toEqual(['root', 'started', 'root', 'started'])
    expect(phaseOf(started, 'started')).toBe('running')
    expect(phaseOf(idle, 'idle')).toBe('pending')
  })
})

describe('dispose', () => {
  it('withdraws services, disposes child containers, then runs container effects in reverse order', async () => {
    const parent = createTestContainer({ owner: { kind: 'parent' } })
    const child = createTestContainer({ parent, owner: { kind: 'child' } })
    const order: string[] = []

    effect(parent, () => () => {
      order.push('parent effect 1')
    })
    effect(parent, () => () => {
      order.push('parent effect 2')
    })
    effect(child, () => () => {
      order.push('child effect')
    })
    const llm = provide(parent, 'airi.llm', ({ on }) => {
      on('stop', () => {
        order.push('parent service stop')
      })
      return 'llm'
    })
    provide(child, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('stop', () => {
          order.push('child service stop')
        })
        return 'speech'
      },
    })
    await start(parent)
    await start(child)

    await dispose(parent)
    // The child container disposes first, with its effects (G11). Then the parent services stop. The parent effects run last, in reverse order.
    expect(order).toEqual(['child service stop', 'child effect', 'parent service stop', 'parent effect 2', 'parent effect 1'])
    expect(() => provide(parent, 'airi.llm', () => 'llm')).toThrow(BuildAfterDisposeError)
    expect(() => createTestContainer({ parent: child })).toThrow(BuildAfterDisposeError)
  })

  it('disposes child containers in reverse creation order, each one with its effects, before the parent services (G11)', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    await start(root)
    const session = createTestContainer({ parent: root, owner: { kind: 'session' } })
    const order: string[] = []
    effect(session, () => () => {
      order.push('session effect')
    })
    provide(session, 'session', ({ on, effect: instanceEffect }) => {
      on('stop', () => order.push('session stop hook'))
      instanceEffect(() => () => {
        order.push('session instance effect')
      })
      return 'session'
    })
    await start(session)
    for (const id of ['first', 'second']) {
      const module = createTestContainer({ parent: session, owner: { kind: 'module', id } })
      effect(module, () => () => {
        order.push(`${id} module effect`)
      })
      provide(module, `module.${id}`, ({ on }) => {
        on('stop', () => order.push(`${id} module stop hook`))
        return id
      })
      await start(module)
    }

    await dispose(session)
    expect(order).toEqual([
      'second module stop hook',
      'second module effect',
      'first module stop hook',
      'first module effect',
      'session stop hook',
      'session instance effect',
      'session effect',
    ])
  })

  it('runs the disposer of an effect at once when the disposal started or ended (G12)', async () => {
    const app = createTestContainer()
    const slow = deferred()
    effect(app, () => () => slow.promise)
    const disposal = dispose(app)

    const during = vi.fn()
    effect(app, () => during)
    expect(during).toHaveBeenCalledTimes(1)

    slow.resolve()
    await disposal
    const after = vi.fn()
    effect(app, () => after)
    expect(after).toHaveBeenCalledTimes(1)
    expect(() => effect(app, () => () => {
      throw new Error('cleanup failed')
    })).toThrow('cleanup failed')
  })

  it('keeps the identity of a single error', async () => {
    const app = createTestContainer()
    const error = new Error('effect failed')
    effect(app, () => () => {
      throw error
    })
    effect(app, () => () => {})

    await expect(dispose(app)).rejects.toBe(error)
  })

  it('collects more than one error into an AggregateError, and runs every cleanup', async () => {
    const app = createTestContainer()
    const child = createTestContainer({ parent: app })
    const serviceError = new Error('stop failed')
    const childError = new Error('child effect failed')
    const effectError = new Error('effect failed')
    const remaining = vi.fn()

    effect(app, () => remaining)
    effect(app, () => () => {
      throw effectError
    })
    effect(child, () => () => {
      throw childError
    })
    provide(app, 'airi.llm', ({ on }) => {
      on('stop', ({ decide }) => decide.fail(serviceError))
      return 'llm'
    })
    await start(app)

    const result = await dispose(app).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    // The errors keep the order of the disposal: the child container first, then the services, then the effects (G11).
    expect((result as AggregateError).errors).toEqual([childError, serviceError, effectError])
    expect(remaining).toHaveBeenCalledTimes(1)
  })

  // Design test 12.
  // The check sees only the synchronous part of a cleanup, in every runtime. A call after an `await` is not detected.
  it('rejects a re-entrant dispose from the synchronous part of an async cleanup, and gives an outside caller the same promise', async () => {
    const app = createTestContainer()
    const remaining = vi.fn()
    let inner: Promise<void> | undefined

    effect(app, () => remaining)
    effect(app, () => async () => {
      inner = dispose(app)
      await inner
    })

    const first = dispose(app)
    const second = dispose(app)
    expect(second).toBe(first)

    await expect(first).rejects.toBeInstanceOf(ReentrantDisposeError)
    await expect(inner).rejects.toMatchObject({ code: 'reentrant-dispose' })
    expect(remaining).toHaveBeenCalledTimes(1)
  })

  it('rejects a synchronous re-entrant dispose from a stop hook and from a child container effect', async () => {
    const parent = createTestContainer()
    const child = createTestContainer({ parent })
    const reentrant: unknown[] = []

    provide(parent, 'airi.llm', ({ on }) => {
      on('stop', () => {
        dispose(parent).catch((error: unknown) => reentrant.push(error))
      })
      return 'llm'
    })
    effect(child, () => () => {
      // The child cleanup belongs to the cleanup chain of the parent.
      dispose(parent).catch((error: unknown) => reentrant.push(error))
    })
    await start(parent)

    await dispose(parent)
    expect(reentrant).toHaveLength(2)
    expect(reentrant.every(error => error instanceof ReentrantDisposeError)).toBe(true)
  })

  it('aborts a running build when its container is disposed, and the late result does not publish', async () => {
    const app = createTestContainer()
    const build = deferred<string>()
    const startHook = vi.fn()
    let signal: AbortSignal | undefined

    const registration = provide(app, 'airi.llm', (context) => {
      signal = context.signal
      context.on('start', startHook)
      return build.promise
    })
    void start(app)
    await drained(app)

    const disposal = dispose(app)
    await drained(app)
    expect(signal?.aborted).toBe(true)

    build.resolve('late')
    await disposal
    expect(startHook).not.toHaveBeenCalled()
    await expect(registration.withdraw()).resolves.toBe(false)
  })
})

describe('dispose with a signal', () => {
  it('stops waiting for a cleanup that does not settle, records it, and a later dispose() gets the result', async () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock })
    const gate = deferred()
    provide(app, 'airi.window', ({ effect }) => {
      effect(() => () => gate.promise)
      return 'window'
    })
    await start(app)
    const { records } = collectRecords(app)

    const aborted = dispose(app, { signal: timeout(app, 50) }).catch((error: unknown) => error)
    await drained(app)
    advance(50)
    expect(await aborted).toMatchObject({ name: 'TimeoutError' })
    await drained(app)
    expect(records).toContainEqual(expect.objectContaining({ type: 'wait-aborted', call: 'dispose', key: 'airi.window', phase: 'stopping' }))

    // The container stays in `disposing`. New work fails, and a later dispose() waits for the same disposal.
    expect(() => provide(app, 'airi.other', () => 'other')).toThrow(BuildAfterDisposeError)
    const later = dispose(app)
    gate.resolve()
    await expect(later).resolves.toBeUndefined()
  })

  it('starts the disposal and rejects at once for an aborted signal', async () => {
    const app = createTestContainer()
    const stopHook = vi.fn()
    provide(app, 'airi.llm', ({ on }) => {
      on('stop', stopHook)
      return 'llm'
    })
    await start(app)

    await expect(dispose(app, { signal: AbortSignal.abort('closed') })).rejects.toBe('closed')
    await dispose(app)
    expect(stopHook).toHaveBeenCalledTimes(1)
  })

  it('removes its listener when the disposal ends', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    await start(app)
    const { signal, listeners } = trackedController()

    await dispose(app, { signal })
    expect(listeners()).toBe(0)
  })
})
