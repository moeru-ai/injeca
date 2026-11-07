import { describe, expect, it } from 'vitest'

import { StartTimeoutError } from '../diagnostics/errors'
import { provide, start, stop, timeout } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, phaseOf, trackedController } from '../testing/helpers'

describe('start with a signal', () => {
  it('rejects with start-timeout for a timeout reason, and the units keep converging', async () => {
    const { clock, advance, pending } = manualClock()
    const app = createTestContainer({ clock })
    provide(app, 'voice.speech', { dependsOn: { tts: 'airi.tts' }, build: () => 'speech' })

    const result = start(app, { signal: timeout(app, 100) }).catch((error: unknown) => error)
    await drained(app)
    advance(100)
    const error = await result
    expect(error).toBeInstanceOf(StartTimeoutError)
    expect(error).toMatchObject({ code: 'start-timeout', cause: expect.objectContaining({ name: 'TimeoutError' }) })
    expect((error as StartTimeoutError).explanations).toEqual([expect.objectContaining({ name: 'voice.speech', phase: 'pending' })])
    expect(pending()).toBe(0)

    // The abort ended only the wait. The container is started, so a later provider makes the unit run.
    provide(app, 'airi.tts', () => 'tts')
    await drained(app)
    expect(phaseOf(app, 'voice.speech')).toBe('running')
  })

  it('rejects with another reason as it is, and removes its listener', async () => {
    const app = createTestContainer()
    provide(app, 'voice.speech', { dependsOn: { tts: 'airi.tts' }, build: () => 'speech' })
    const { controller, signal, listeners } = trackedController()
    const reason = new Error('the window closed')

    const result = start(app, { signal })
    await drained(app)
    expect(listeners()).toBe(1)
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
    expect(listeners()).toBe(0)
  })

  it('begins convergence and rejects at once for an aborted signal', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')

    await expect(start(app, { signal: AbortSignal.abort('closed') })).rejects.toBe('closed')
    await drained(app)
    expect(phaseOf(app, 'airi.llm')).toBe('running')
  })

  it('removes its listener when every unit runs', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    const { signal, listeners } = trackedController()

    await start(app, { signal })
    expect(listeners()).toBe(0)
  })
})

describe('stop with a signal', () => {
  it('stops waiting for a cleanup that does not settle, records it, and the cleanup keeps running', async () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock })
    const gate = deferred()
    let stopped = false
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', async () => {
        await gate.promise
        stopped = true
      })
      return 'tray'
    })
    await start(app)
    const { records } = collectRecords(app)

    const result = stop(app, { signal: timeout(app, 50) }).catch((error: unknown) => error)
    await drained(app)
    advance(50)
    expect(await result).toMatchObject({ name: 'TimeoutError' })
    await drained(app)
    expect(records).toContainEqual(expect.objectContaining({ type: 'wait-aborted', call: 'stop', key: 'airi.tray', phase: 'stopping', abortReason: expect.objectContaining({ name: 'TimeoutError' }) }))
    expect(phaseOf(app, 'airi.tray')).toBe('stopping')

    gate.resolve()
    await drained(app)
    expect(stopped).toBe(true)
    expect(phaseOf(app, 'airi.tray')).toBe('pending')

    // The container stayed stopped. A later start builds again.
    await start(app)
    expect(phaseOf(app, 'airi.tray')).toBe('running')
  })

  it('begins the stop and rejects at once for an aborted signal', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    await start(app)

    await expect(stop(app, { signal: AbortSignal.abort('closed') })).rejects.toBe('closed')
    await drained(app)
    expect(phaseOf(app, 'airi.llm')).toBe('pending')
  })

  it('removes its listener when every unit stopped', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    await start(app)
    const { signal, listeners } = trackedController()

    await stop(app, { signal })
    expect(listeners()).toBe(0)
  })
})
