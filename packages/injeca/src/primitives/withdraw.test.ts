import { describe, expect, it } from 'vitest'

import { dispose, invoke, provide, start, stop } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, phaseOf, warningLogger } from '../testing/helpers'

describe('withdraw with a signal', () => {
  it('stops waiting when the signal aborts, and the withdrawal continues', async () => {
    const app = createTestContainer()
    const { records } = collectRecords(app)
    const gate = deferred()
    const llm = provide(app, 'airi.llm', ({ on }) => {
      on('stop', () => gate.promise)
      return 'llm'
    })
    await start(app)

    const controller = new AbortController()
    const withdrawal = llm.withdraw({ signal: controller.signal })
    await drained(app)
    const reason = new Error('The user closed the settings page.')
    controller.abort(reason)
    await expect(withdrawal).rejects.toBe(reason)
    expect(records).toContainEqual(expect.objectContaining({ type: 'wait-aborted', call: 'withdraw', key: 'airi.llm', phase: 'stopping', abortReason: reason }))

    gate.resolve()
    await drained(app)
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'airi.llm', to: 'withdrawn' }))
  })

  it('starts the withdrawal with an aborted signal, then rejects at once', async () => {
    const app = createTestContainer()
    const { records } = collectRecords(app)
    const llm = provide(app, 'airi.llm', () => 'llm')
    await start(app)

    const reason = new Error('aborted')
    await expect(llm.withdraw({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    await drained(app)
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'airi.llm', to: 'withdrawn' }))
    await expect(llm.withdraw({ signal: AbortSignal.abort(reason) })).resolves.toBe(false)
  })

  it('rejects an invalid signal, and takes a signal for an invocation', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'llm')
    await expect(llm.withdraw({ signal: 'soon' as unknown as AbortSignal })).rejects.toMatchObject({ code: 'invalid-argument' })

    const handle = invoke(app, () => {})
    await start(app)
    await expect(handle.withdraw({ signal: new AbortController().signal })).resolves.toBe(true)
    await expect(handle.withdraw()).resolves.toBe(false)
  })
})

describe('a re-entrant withdraw', () => {
  it('resolves at once when a stop hook withdraws its own registration with its signal', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const { records } = collectRecords(app)
    let inner: Promise<boolean> | undefined
    const window = provide(app, 'plugin.window', ({ on }) => {
      on('stop', async ({ signal }) => {
        await Promise.resolve()
        inner = window.withdraw({ signal })
        await inner
      })
      return 'window'
    })
    await start(app)

    await expect(stop(app)).resolves.toBeUndefined()
    await expect(inner).resolves.toBe(true)
    expect(records).toContainEqual(expect.objectContaining({ type: 'phase', key: 'plugin.window', to: 'withdrawn' }))
    expect(warnings).toEqual(['The cleanup of \'plugin.window\' in {} called withdraw() of \'plugin.window\' in {}, and the wait includes that cleanup. injeca resolved the call at once. The withdrawal continues.'])
    expect(records).toContainEqual(expect.objectContaining({ type: 'reentrant-call', call: 'withdraw', key: 'plugin.window' }))
  })

  it('resolves at once when a dependent cleanup withdraws its provider with its signal', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const llm = provide(app, 'airi.llm', () => 'llm')
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ effect, signal }) => {
        effect(() => async () => {
          await Promise.resolve()
          await llm.withdraw({ signal })
        })
        return 'speech'
      },
    })
    await start(app)

    await expect(stop(app)).resolves.toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('The cleanup of \'voice.speech\' in {} called withdraw() of \'airi.llm\'')])
  })

  it('resolves at once from the synchronous part of a cleanup', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    let inner: Promise<boolean> | undefined
    const window = provide(app, 'plugin.window', ({ on }) => {
      on('stop', () => {
        inner = window.withdraw()
      })
      return 'window'
    })
    await start(app)

    await stop(app)
    await expect(inner).resolves.toBe(true)
    expect(warnings).toEqual([expect.stringContaining('called withdraw()')])
  })

  it('waits for a signal of a service that the withdrawal does not wait for', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const gate = deferred()
    const llm = provide(app, 'airi.llm', ({ on }) => {
      on('stop', () => gate.promise)
      return 'llm'
    })
    let otherSignal: AbortSignal | undefined
    provide(app, 'airi.tray', ({ on, signal }) => {
      otherSignal = signal
      on('stop', () => new Promise<void>(() => {}))
      return 'tray'
    })
    await start(app)
    // The tray is stopping, but the withdrawal of the llm does not wait for it.
    void stop(app)
    await drained(app)

    let settled = false
    const withdrawal = llm.withdraw({ signal: otherSignal }).finally(() => {
      settled = true
    })
    await drained(app)
    expect(settled).toBe(false)
    gate.resolve()
    await expect(withdrawal).resolves.toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('a stop hook that withdraws its exports, then disposes its container', () => {
  it('withdraws the export, and the stop and the disposal resolve', async () => {
    const { logger, warnings } = warningLogger()
    const app = createTestContainer({ logger })
    const plugin = createTestContainer({ parent: app, owner: { plugin: 'weather' }, logger })
    const tool = provide(plugin, 'plugin.tool', { export: true, build: () => 'tool' })
    let host: Promise<void> | undefined
    provide(plugin, 'plugin.host', ({ on }) => {
      on('stop', async ({ signal }) => {
        await Promise.resolve()
        await tool.withdraw({ signal })
        host = dispose(plugin, { signal })
        await host
      })
      return 'host'
    })
    await start(app)
    await start(plugin)
    expect(phaseOf(app, 'plugin.tool')).toBe('running')

    await expect(stop(app)).resolves.toBeUndefined()
    await expect(host).resolves.toBeUndefined()
    await expect(dispose(plugin)).resolves.toBeUndefined()
    expect(phaseOf(app, 'plugin.tool')).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('called dispose() of {"plugin":"weather"}')])
  })
})
