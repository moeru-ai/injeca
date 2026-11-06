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

  it('waits as usual for a signal of a unit that is not stopping', async () => {
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

describe('a re-entrant call during a rebuild', () => {
  it('resolves at once from a cleanup of a successor whose build failed, while the unit is not stopping', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const { records } = collectRecords(app)
    const llm = provide(app, 'airi.llm', () => 'llm 1')
    let builds = 0
    let cleanupDone = false
    provide(app, 'airi.window', {
      dependsOn: { llm: 'airi.llm' },
      build: ({ effect, signal }) => {
        builds++
        if (builds === 2) {
          effect(() => async () => {
            await Promise.resolve()
            await dispose(app, { signal })
            cleanupDone = true
          })
          throw new Error('The second window did not open.')
        }
        return 'window'
      },
    })
    await start(app)

    // The new provider instance rebuilds the window make-before-break. The successor fails in build, so its teardown runs in `building`.
    await llm.replace(() => 'llm 2')
    await drained(app)
    expect(builds).toBe(2)
    expect(cleanupDone).toBe(true)
    expect(warnings).toEqual([expect.stringContaining('The cleanup of \'airi.window\' in {} called dispose()')])
    expect(records).toContainEqual(expect.objectContaining({ type: 'reentrant-call', call: 'dispose', key: 'airi.window' }))
    await expect(dispose(app)).resolves.toBeUndefined()
  })

  it('waits for a signal of the new running instance while the old instance stops', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const llm = provide(app, 'airi.llm', () => 'llm 1')
    const signals: AbortSignal[] = []
    const panelStopGate = deferred()
    provide(app, 'airi.window', {
      dependsOn: { llm: 'airi.llm' },
      build: ({ signal }) => {
        signals.push(signal)
        return 'window'
      },
    })
    // The panel holds the window. Its stop hooks wait, so the old window instance and later the new one wait for their holders.
    provide(app, 'airi.panel', {
      dependsOn: { window: 'airi.window' },
      build: ({ on }) => {
        on('stop', () => panelStopGate.promise)
        return 'panel'
      },
    })
    await start(app)
    await llm.replace(() => 'llm 2')
    await drained(app)
    expect(signals).toHaveLength(2)
    expect(phaseOf(app, 'airi.window')).toBe('running')

    let settled = false
    const stopped = stop(app, { signal: signals[1] }).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(false)
    expect(warnings).toEqual([])

    panelStopGate.resolve()
    // The signal of the new instance aborts when that instance is disposed. That ends the wait, as for any other signal.
    await expect(stopped).rejects.toThrow('was disposed')
    expect(warnings).toEqual([])
  })
})

describe('a cleanup outside the subtree that holds a unit of it', () => {
  // The parent unit holds a parent-visible unit of a plugin container. Its stop hook disposes the plugin, as a plugin host does with `host.stop(id, { signal })`.
  // The disposal of the plugin withdraws that unit, and the unit waits for its holders. So the disposal waits for the cleanup that called it.
  function setup() {
    const manual = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ clock: manual.clock, logger, timeouts: { stop: 1_000 } })
    const plugin = createTestContainer({ parent: app, owner: { plugin: 'weather' }, logger })
    const { records } = collectRecords(app)
    const toolStopGate = deferred()
    provide(plugin, 'plugin.tool', {
      visibility: 'parent',
      build: ({ on }) => {
        on('stop', () => toolStopGate.promise)
        return 'tool'
      },
    })

    return { ...manual, app, plugin, records, warnings, toolStopGate }
  }

  it('resolves at once when the holder disposes the plugin with its signal', async () => {
    const { app, plugin, records, warnings, toolStopGate, pending } = setup()
    toolStopGate.resolve()
    let inner: Promise<void> | undefined
    provide(app, 'airi.panel', {
      dependsOn: { tool: 'plugin.tool' },
      build: ({ on }) => {
        on('stop', async ({ signal }) => {
          await Promise.resolve()
          inner = dispose(plugin, { signal })
          await inner
        })
        return 'panel'
      },
    })
    await start(app)
    await start(plugin)
    expect(phaseOf(app, 'airi.panel')).toBe('running')

    let settled = false
    const stopped = stop(app).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(true)
    await expect(stopped).resolves.toBeUndefined()
    await expect(inner).resolves.toBeUndefined()
    expect(pending()).toBe(0)
    expect(warnings).toEqual([expect.stringContaining('The cleanup of \'airi.panel\' in {} called dispose() of {"plugin":"weather"}')])
    expect(records.filter(record => record.type === 'reentrant-call')).toEqual([expect.objectContaining({ call: 'dispose', key: 'airi.panel' })])
    await expect(dispose(plugin)).resolves.toBeUndefined()
    expect(phaseOf(app, 'plugin.tool')).toBeUndefined()
  })

  it('resolves at once when the holder stops the plugin with its signal', async () => {
    const { app, plugin, records, warnings, toolStopGate } = setup()
    toolStopGate.resolve()
    provide(app, 'airi.panel', {
      dependsOn: { tool: 'plugin.tool' },
      build: ({ on }) => {
        on('stop', async ({ signal }) => {
          await Promise.resolve()
          await stop(plugin, { signal })
        })
        return 'panel'
      },
    })
    await start(app)
    await start(plugin)

    let settled = false
    const stopped = stop(app).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(true)
    await expect(stopped).resolves.toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('called stop() of {"plugin":"weather"}')])
    expect(records.filter(record => record.type === 'reentrant-call')).toEqual([expect.objectContaining({ call: 'stop', key: 'airi.panel' })])
  })

  it('resolves at once when the holder holds a consumer unit of a parent-visible per-container registration', async () => {
    const { clock, pending } = manualClock()
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ clock, logger, timeouts: { stop: 1_000 } })
    const plugin = createTestContainer({ parent: app, owner: { plugin: 'weather' }, logger })
    provide(plugin, 'plugin.client', { visibility: 'parent', instances: 'per-container', build: () => 'client' })
    // The panel holds a unit that holds the consumer unit. The consumer unit lives in `app`, but the disposal of the plugin withdraws it.
    provide(app, 'airi.session', { dependsOn: { client: 'plugin.client' }, build: () => 'session' })
    provide(app, 'airi.panel', {
      dependsOn: { session: 'airi.session' },
      build: ({ on }) => {
        on('stop', async ({ signal }) => {
          await Promise.resolve()
          await dispose(plugin, { signal })
        })
        return 'panel'
      },
    })
    await start(app)
    await start(plugin)
    expect(phaseOf(app, 'airi.panel')).toBe('running')

    let settled = false
    const stopped = stop(app).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(true)
    await expect(stopped).resolves.toBeUndefined()
    expect(pending()).toBe(0)
    expect(warnings).toEqual([expect.stringContaining('called dispose() of {"plugin":"weather"}')])
  })

  it('waits for a signal of a holder that is not stopping', async () => {
    const { app, plugin, warnings, toolStopGate } = setup()
    const panelStopGate = deferred()
    let panelSignal: AbortSignal | undefined
    provide(app, 'airi.panel', {
      dependsOn: { tool: 'plugin.tool' },
      build: ({ on, signal }) => {
        panelSignal = signal
        on('stop', () => panelStopGate.promise)
        return 'panel'
      },
    })
    await start(app)
    await start(plugin)

    let settled = false
    const disposal = dispose(plugin, { signal: panelSignal }).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(false)
    expect(phaseOf(app, 'airi.panel')).toBe('stopping')

    panelStopGate.resolve()
    toolStopGate.resolve()
    // The signal of the panel aborts when its instance is disposed. That ends this wait, as for any other signal.
    await expect(disposal).rejects.toThrow('was disposed')
    expect(warnings).toEqual([])
  })

  it('waits for a signal of a stopping unit that holds nothing of the plugin', async () => {
    const { app, plugin, records, warnings, toolStopGate } = setup()
    let traySignal: AbortSignal | undefined
    const tray = provide(app, 'airi.tray', ({ on, signal }) => {
      traySignal = signal
      on('stop', () => new Promise<void>(() => {}))
      return 'tray'
    })
    await start(app)
    await start(plugin)
    void tray.withdraw()
    await drained(app)
    // The withdrawn tray leaves the slot, so only the observe stream shows its phase.
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'airi.tray', to: 'stopping' }))

    let settled = false
    const disposal = dispose(plugin, { signal: traySignal }).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(false)

    toolStopGate.resolve()
    await expect(disposal).resolves.toBeUndefined()
    expect(warnings).toEqual([])
  })
})
