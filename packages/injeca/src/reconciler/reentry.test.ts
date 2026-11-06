import { describe, expect, it } from 'vitest'

import { dispose, provide, start, stop, withTimeout } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, manualClock, phaseOf, warningLogger } from '../testing/helpers'

describe('a cleanup that awaits the disposal of its own container with its signal', () => {
  it('resolves at once from a stop hook, warns, and the disposal completes without a timeout', async () => {
    const { clock, pending } = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ clock, logger })
    const { records } = collectRecords(app)
    let inner: Promise<void> | undefined
    let cleanupDone = false
    provide(app, 'airi.window', ({ on }) => {
      on('stop', async ({ signal }) => {
        await Promise.resolve()
        inner = dispose(app, { signal })
        await inner
        cleanupDone = true
      })
      return 'window'
    })
    await start(app)

    const disposal = dispose(app)
    expect(dispose(app)).toBe(disposal)
    await expect(disposal).resolves.toBeUndefined()
    await expect(inner).resolves.toBeUndefined()
    expect(cleanupDone).toBe(true)
    expect(pending()).toBe(0)
    expect(warnings).toEqual([expect.stringContaining('The cleanup of \'airi.window\'')])
    expect(records).toContainEqual(expect.objectContaining({ type: 'reentrant-call', call: 'dispose', key: 'airi.window' }))
  })

  it('resolves at once from an effect disposer with the build signal', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    provide(app, 'airi.tray', ({ effect, signal }) => {
      effect(() => async () => {
        await Promise.resolve()
        await dispose(app, { signal })
      })
      return 'tray'
    })
    await start(app)

    await expect(dispose(app)).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('resolves at once when a child cleanup awaits the disposal of the parent', async () => {
    const { logger, warnings } = warningLogger()
    const parent = createTestContainer({ logger })
    const child = createTestContainer({ parent })
    provide(child, 'plugin.reaction', ({ on }) => {
      on('stop', async ({ signal }) => {
        await Promise.resolve()
        await dispose(parent, { signal })
      })
      return 'reaction'
    })
    await start(parent)
    await start(child)

    await expect(dispose(parent)).resolves.toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('called dispose()')])
  })

  it('keeps the origin through withTimeout', async () => {
    const { clock } = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ clock, logger })
    provide(app, 'airi.window', ({ on }) => {
      on('stop', async ({ signal }) => {
        await Promise.resolve()
        await dispose(app, { signal: withTimeout(signal, 1_000, app) })
      })
      return 'window'
    })
    await start(app)

    await expect(dispose(app)).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('resolves a stop() from a stop hook at once, and the stop continues', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const { records } = collectRecords(app)
    const gate = deferred()
    provide(app, 'airi.window', ({ on }) => {
      on('stop', async ({ signal }) => {
        await Promise.resolve()
        await stop(app, { signal })
        await gate.promise
      })
      return 'window'
    })
    await start(app)

    const stopped = stop(app)
    await drained(app)
    expect(warnings).toEqual([expect.stringContaining('called stop()')])
    expect(records).toContainEqual(expect.objectContaining({ type: 'reentrant-call', call: 'stop', key: 'airi.window' }))
    expect(phaseOf(app, 'airi.window')).toBe('stopping')
    gate.resolve()
    await expect(stopped).resolves.toBeUndefined()
    expect(phaseOf(app, 'airi.window')).toBe('pending')
  })

  it('waits as usual for a signal of a service that is not stopping', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    let buildSignal: AbortSignal | undefined
    const stopGate = deferred()
    provide(app, 'airi.window', ({ on, signal }) => {
      buildSignal = signal
      on('stop', () => stopGate.promise)
      return 'window'
    })
    await start(app)

    let settled = false
    const disposal = dispose(app, { signal: buildSignal }).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(false)

    // The build signal aborts when the instance is disposed. That ends this wait, as for any other signal.
    stopGate.resolve()
    await expect(disposal).rejects.toThrow('was disposed')
    expect(warnings).toEqual([])
  })
})
