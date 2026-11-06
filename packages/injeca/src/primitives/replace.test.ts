import type { BuildContext } from '../types'

import { describe, expect, it, vi } from 'vitest'

import { ReplaceWhileStoppingError, WaitTimeoutError } from '../diagnostics/errors'
import { describeExplanations } from '../diagnostics/explain'
import { graph, provide, resolve, start, stop, timeout } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, stateOf, trackedController } from '../testing/helpers'

describe('replace', () => {
  it('does not let a stale registration replace a newer unit (design test 1)', async () => {
    const app = createTestContainer()
    const first = provide(app, 'airi.llm', () => 'first')
    const second = provide(app, 'airi.llm', () => 'second')
    await start(app)

    await expect(first.replace(() => 'from stale')).resolves.toBe(false)
    expect(stateOf(app, 'airi.llm').phase).toBe('running')

    await second.withdraw()
    await expect(second.replace(() => 'after withdraw')).resolves.toBe(false)
  })

  it('replaces an unavailable unit. The new instance is ready after start, and dependents return to ready (design test 24)', async () => {
    const app = createTestContainer()
    let setStatus: BuildContext['setStatus'] = () => {}
    const llm = provide(app, 'airi.llm', (context) => {
      setStatus = context.setStatus
      return 'old'
    })
    const speechBuild = vi.fn(({ dependsOn }: { dependsOn: { llm: string } }) => `speech(${dependsOn.llm})`)
    provide(app, 'voice.speech', { dependsOn: { llm }, build: speechBuild })
    await start(app)

    setStatus('unavailable', 'gateway down')
    await drained(app)
    expect(stateOf(app, 'voice.speech').status).toBe('unavailable')
    const oldId = stateOf(app, llm).instanceId

    await expect(llm.replace(() => 'new')).resolves.toBe(true)
    await drained(app)

    const state = stateOf(app, llm)
    expect(state).toMatchObject({ phase: 'running', status: 'ready' })
    expect(state.instanceId).not.toBe(oldId)
    expect(stateOf(app, 'voice.speech')).toMatchObject({ phase: 'running', status: 'ready' })
    // The dependent has no handler, so it rebuilds with the new instance.
    expect(speechBuild).toHaveBeenLastCalledWith(expect.objectContaining({ dependsOn: { llm: 'new' } }))
  })

  it('keeps the old instance and its status when the new start fails (design test 25)', async () => {
    const app = createTestContainer()
    let setStatus: BuildContext['setStatus'] = () => {}
    const oldStop = vi.fn()
    const llm = provide(app, 'airi.llm', (context) => {
      setStatus = context.setStatus
      context.on('stop', oldStop)
      return 'old'
    })
    const speechBuild = vi.fn(() => 'speech')
    provide(app, 'voice.speech', { dependsOn: { llm }, build: speechBuild })
    await start(app)
    setStatus('degraded', 'fallback voice')
    await drained(app)
    const { records } = collectRecords(app)
    const before = stateOf(app, llm)

    const error = new Error('cannot listen')
    const newStop = vi.fn()
    await expect(llm.replace(({ on }) => {
      on('start', () => {
        throw error
      })
      on('stop', newStop)
      return 'new'
    })).rejects.toBe(error)
    await drained(app)

    expect(stateOf(app, llm)).toEqual(before)
    expect(stateOf(app, llm).status).toBe('degraded')
    expect(speechBuild).toHaveBeenCalledTimes(1)
    expect(oldStop).not.toHaveBeenCalled()
    // A failed start runs the stop hooks of the new instance, as for any start that fails.
    expect(newStop).toHaveBeenCalledTimes(1)
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'airi.llm', to: 'failed' }))

    // The registration stays current. A later replace works.
    await expect(llm.replace(() => 'newer')).resolves.toBe(true)
  })

  it('keeps the old instance when the new build fails', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const before = stateOf(app, llm)

    const error = new Error('bad module')
    await expect(llm.replace(() => {
      throw error
    })).rejects.toBe(error)
    expect(stateOf(app, llm)).toEqual(before)
  })

  it('serves the old instance during the new build and start, and swaps in one batch', async () => {
    const app = createTestContainer()
    const startGate = deferred()
    const llm = provide(app, 'airi.llm', () => 'old')
    const changes: unknown[] = []
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('dependency-change', ({ dependsOn, changes: list, decide }) => {
          changes.push({ value: dependsOn.llm.value, changes: list.length })
          return decide.handled()
        })
        return 'speech'
      },
    })
    await start(app)
    const oldId = stateOf(app, llm).instanceId

    const replaced = llm.replace(({ on }) => {
      on('start', () => startGate.promise)
      return 'new'
    })
    await drained(app)
    // The new instance is starting. The old instance still serves.
    expect(stateOf(app, llm)).toMatchObject({ phase: 'running', instanceId: oldId })
    expect(changes).toEqual([])

    startGate.resolve()
    await expect(replaced).resolves.toBe(true)
    await drained(app)
    expect(stateOf(app, llm).instanceId).not.toBe(oldId)
    expect(changes).toEqual([{ value: 'new', changes: 1 }])
  })

  it('disposes the old instance only after the last holder moves to the new instance (design test 26)', async () => {
    const app = createTestContainer()
    const order: string[] = []
    const holdGate = deferred()
    const llm = provide(app, 'airi.llm', ({ on }) => {
      on('stop', () => {
        order.push('old llm stop')
      })
      return 'old'
    })
    // The first holder moves at once with its handler.
    provide(app, 'voice.fast', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('dependency-change', ({ decide }) => decide.handled())
        return 'fast'
      },
    })
    // The second holder has no handler. It stops and rebuilds, and its stop hook waits.
    provide(app, 'voice.slow', {
      dependsOn: { llm },
      build: ({ on, dependsOn }) => {
        on('stop', async () => {
          order.push(`slow stop with ${dependsOn.llm}`)
          await holdGate.promise
        })
        return 'slow'
      },
    })
    await start(app)

    await llm.replace(() => 'new')
    await drained(app)
    expect(order).toEqual(['slow stop with old'])

    holdGate.resolve()
    await drained(app)
    expect(order).toEqual(['slow stop with old', 'old llm stop'])
    expect(stateOf(app, 'voice.slow').phase).toBe('running')
  })

  it('fails with replace-while-stopping for a unit in stopping (design test 27)', async () => {
    const app = createTestContainer()
    const holdGate = deferred()
    const llm = provide(app, 'airi.llm', () => 'llm')
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('stop', () => holdGate.promise)
        return 'speech'
      },
    })
    await start(app)

    // `stop()` keeps the registrations. The provider waits for its holder in `stopping`.
    const stopped = stop(app)
    await drained(app)
    expect(stateOf(app, llm).phase).toBe('stopping')
    await expect(llm.replace(() => 'new')).rejects.toBeInstanceOf(ReplaceWhileStoppingError)

    holdGate.resolve()
    await stopped
  })

  it('replaces a unit that does not run at once', async () => {
    const app = createTestContainer()
    const build = vi.fn(() => 'new')
    const llm = provide(app, 'airi.llm', {
      dependsOn: { missing: 'not.provided' },
      build: () => 'old',
    })
    void start(app)
    await drained(app)
    expect(stateOf(app, llm).phase).toBe('pending')

    await expect(llm.replace(build)).resolves.toBe(true)
    await drained(app)
    expect(stateOf(app, llm).phase).toBe('running')
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('lets a newer replace supersede a pending one, and a withdrawal cancel it', async () => {
    const app = createTestContainer()
    const gate = deferred()
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)

    const first = llm.replace(({ on }) => {
      on('start', () => gate.promise)
      return 'first'
    })
    await drained(app)
    const second = llm.replace(() => 'second')
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    gate.resolve()

    const third = llm.replace(({ on }) => {
      on('start', () => new Promise(() => {}))
      return 'third'
    })
    await drained(app)
    await expect(llm.withdraw()).resolves.toBe(true)
    await expect(third).resolves.toBe(false)
    expect(stateOf(app, llm).phase).toBeUndefined()
  })

  it('keeps the metadata when the option has none, and takes new dependencies', async () => {
    const app = createTestContainer()
    const config = provide(app, 'airi.config', () => ({ model: 'gpt' }))
    const llm = provide(app, 'airi.llm', { metadata: { version: '1.0.0' }, build: () => 'old' })
    await start(app)

    const build = vi.fn((model: string) => model)
    await llm.replace({ dependsOn: { config }, build: ({ dependsOn }) => build(dependsOn.config.model) })
    expect(build).toHaveBeenCalledTimes(1)
    expect(stateOf(app, llm).phase).toBe('running')
  })

  it('adds the pending successor to explain(), with its phase and blockers', async () => {
    const app = createTestContainer()
    const module = provide(app, 'module', () => 1)
    await start(app)

    void module.replace({ dependsOn: { missing: 'missing' }, build: () => 2 })
    await drained(app)
    expect(graph(app).explain('module')).toMatchObject({
      phase: 'running',
      blockers: [],
      replacement: { name: 'module', phase: 'pending', blockers: [{ kind: 'missing-provider', dependency: 'missing', key: 'missing' }] },
    })
    expect(describeExplanations([graph(app).explain('module')])).toBe(`- module is running: its replacement is pending (no provider for 'missing' (missing))`)

    provide(app, 'missing', () => 'here')
    await drained(app)
    expect(graph(app).explain('module')).not.toHaveProperty('replacement')
  })
})

describe('replace with a signal', () => {
  it('rejects with wait-timeout and a message that names the missing dependency for a timeout reason. The old instance stays', async () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock })
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const oldId = stateOf(app, llm).instanceId
    const { records } = collectRecords(app)
    const signal = timeout(app, 50)

    const replaced = llm.replace({ dependsOn: { gateway: 'airi.gateway' }, build: () => 'new' }, { signal })
    const rejection = expect(replaced).rejects
    await drained(app)
    expect(graph(app).explain('airi.llm').replacement).toMatchObject({ phase: 'pending' })
    advance(50)

    await rejection.toBeInstanceOf(WaitTimeoutError)
    const error = await replaced.catch((caught: unknown) => caught) as WaitTimeoutError
    expect(error.code).toBe('wait-timeout')
    expect(error.cause).toBe(signal.reason)
    expect(error.message).toBe(`replace('airi.llm') timed out before the swap. The replacement is not running:\n- airi.llm is pending: no provider for 'airi.gateway' (gateway)`)

    await drained(app)
    expect(stateOf(app, llm)).toMatchObject({ phase: 'running', instanceId: oldId })
    expect(graph(app).explain('airi.llm')).not.toHaveProperty('replacement')
    // The abort cancels the replacement. No work continues without a waiter, so there is no `wait-aborted` record.
    expect(records.filter(record => record.type === 'wait-aborted')).toEqual([])
  })

  it('names a start hook that did not settle in the timeout error', async () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock })
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const newStop = vi.fn()

    const replaced = llm.replace(({ on }) => {
      on('start', () => new Promise<void>(() => {}))
      on('stop', newStop)
      return 'new'
    }, { signal: timeout(app, 50) })
    const rejection = expect(replaced).rejects.toThrow(`replace('airi.llm') timed out before the swap. The replacement is not running:\n- airi.llm is starting`)
    await drained(app)
    advance(50)
    await rejection
    await drained(app)

    expect(newStop).toHaveBeenCalledTimes(1)
    await expect(resolve(app, { llm })).resolves.toEqual({ llm: 'old' })
  })

  it('rejects with the reason as it is for another reason, and cancels the replacement', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const { controller, signal, listeners } = trackedController()
    const reason = new Error('the user closed the window')

    const replaced = llm.replace({ dependsOn: { gateway: 'airi.gateway' }, build: () => 'new' }, { signal })
    await drained(app)
    controller.abort(reason)
    await expect(replaced).rejects.toBe(reason)
    expect(listeners()).toBe(0)

    provide(app, 'airi.gateway', () => 'gateway')
    await drained(app)
    await expect(resolve(app, { llm })).resolves.toEqual({ llm: 'old' })
  })

  it('rejects at once for an aborted signal and changes nothing', async () => {
    const app = createTestContainer()
    const build = vi.fn(() => 'new')
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)

    await expect(llm.replace(build, { signal: AbortSignal.abort('closed') })).rejects.toBe('closed')
    const timedOut = AbortSignal.abort(new DOMException('The time ran out.', 'TimeoutError'))
    const error = await llm.replace(build, { signal: timedOut }).catch((caught: unknown) => caught) as WaitTimeoutError
    expect(error).toBeInstanceOf(WaitTimeoutError)
    expect(error.message).toBe(`replace('airi.llm') timed out before the swap.`)
    expect(error.cause).toBe(timedOut.reason)

    await drained(app)
    expect(build).not.toHaveBeenCalled()
    await expect(resolve(app, { llm })).resolves.toEqual({ llm: 'old' })
  })

  it('resolves false for a stale registration, also with an aborted signal', async () => {
    const app = createTestContainer()
    const first = provide(app, 'airi.llm', () => 'first')
    provide(app, 'airi.llm', () => 'second')
    await start(app)

    await expect(first.replace(() => 'stale', { signal: AbortSignal.abort('closed') })).resolves.toBe(false)
  })

  it('resolves false when a newer replace supersedes it. A later abort has no effect, and the listener goes', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const { controller, signal, listeners } = trackedController()

    const first = llm.replace({ dependsOn: { gateway: 'airi.gateway' }, build: () => 'first' }, { signal })
    await drained(app)
    const second = llm.replace(() => 'second')
    await expect(first).resolves.toBe(false)
    expect(listeners()).toBe(0)
    controller.abort('late')
    await expect(second).resolves.toBe(true)
    await expect(resolve(app, { llm })).resolves.toEqual({ llm: 'second' })
  })

  it('removes its listener after the swap, and an abort then has no effect', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const { controller, signal, listeners } = trackedController()

    await expect(llm.replace(() => 'new', { signal })).resolves.toBe(true)
    expect(listeners()).toBe(0)
    controller.abort('late')
    await drained(app)
    await expect(resolve(app, { llm })).resolves.toEqual({ llm: 'new' })
  })

  it('cancels a pending per-container replacement and rejects with the reason. The old consumer units stay', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const client = provide(root, 'host.client', { instances: 'per-container', build: () => 'v1' })
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'e' } })
    await start(root)
    await start(extension)
    await resolve(extension, { client })

    const { controller, signal, listeners } = trackedController()
    const replaced = client.replace(({ on }) => {
      on('start', () => new Promise<void>(() => {}))
      return 'v2'
    }, { signal })
    await drained(root)
    controller.abort('cancelled')
    await expect(replaced).rejects.toBe('cancelled')
    expect(listeners()).toBe(0)
    await drained(root)
    await expect(resolve(extension, { client })).resolves.toEqual({ client: 'v1' })
  })

  it('names each waiting consumer unit in the timeout error of a per-container replacement', async () => {
    const { clock, advance } = manualClock()
    const root = createTestContainer({ owner: { kind: 'host' }, clock })
    const client = provide(root, 'host.client', { instances: 'per-container', build: () => 'v1' })
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'e' } })
    const other = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'f' } })
    await start(root)
    await start(extension)
    await start(other)
    await resolve(extension, { client })
    await resolve(other, { client })

    const replaced = client.replace({ dependsOn: { gateway: 'host.gateway' }, build: () => 'v2' }, { signal: timeout(root, 50) })
    const rejection = replaced.catch((caught: unknown) => caught)
    await drained(root)
    advance(50)
    const error = await rejection as WaitTimeoutError

    expect(error).toBeInstanceOf(WaitTimeoutError)
    expect(error.message).toBe(`replace('host.client') timed out before the swap. The replacement is not running:\n- host.client is pending: no provider for 'host.gateway' (gateway)\n- host.client is pending: no provider for 'host.gateway' (gateway)`)
    await drained(root)
    await expect(resolve(extension, { client })).resolves.toEqual({ client: 'v1' })
    await expect(resolve(other, { client })).resolves.toEqual({ client: 'v1' })
  })
})
