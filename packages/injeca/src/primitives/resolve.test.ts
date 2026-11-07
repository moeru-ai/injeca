import type { Container } from '../types'

import { describe, expect, it } from 'vitest'

import { WaitTimeoutError } from '../diagnostics/errors'
import { nodeOf } from '../graph/nodes'
import { graph, provide, resolve, start, timeout } from '../scoped'
import { createTestContainer, drained, manualClock, trackedController } from '../testing/helpers'

/** The internal units of a container, with the hidden resolvers of `resolve` calls. */
function nodeUnits(container: Container) {
  return nodeOf(container).units
}

describe('resolve bounds (G4)', () => {
  it('rejects with wait-timeout when a timeout signal on the container clock aborts, and removes its hidden resolver', async () => {
    const { clock, advance, pending } = manualClock()
    const app = createTestContainer({ clock })
    await start(app)

    const timed = resolve(app, { llm: 'airi.llm' }, { signal: timeout(app, 50) }).catch((error: unknown) => error)
    await drained(app)
    expect(pending()).toBe(1)
    advance(50)
    const error = await timed
    expect(error).toBeInstanceOf(WaitTimeoutError)
    expect((error as WaitTimeoutError).cause).toMatchObject({ name: 'TimeoutError' })
    await drained(app)
    expect(pending()).toBe(0)
    expect(graph(app).units()).toEqual([])
    expect([...nodeUnits(app)]).toEqual([])
  })

  it('rejects with the abort reason, also when the signal aborted before the call', async () => {
    const app = createTestContainer()
    const { controller, signal, listeners } = trackedController()
    const reason = new Error('cancelled')
    const waiting = resolve(app, { llm: 'airi.llm' }, { signal })
    expect(listeners()).toBe(1)
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    await expect(resolve(app, { llm: 'airi.llm' }, { signal })).rejects.toBe(reason)
    await drained(app)
    expect([...nodeUnits(app)]).toEqual([])
  })

  it('rejects with wait-timeout at once for a signal that already timed out', async () => {
    const { clock, advance } = manualClock()
    const app = createTestContainer({ clock })
    const signal = timeout(app, 0)
    advance(0)
    await expect(resolve(app, { llm: 'airi.llm' }, { signal })).rejects.toBeInstanceOf(WaitTimeoutError)
    expect([...nodeUnits(app)]).toEqual([])
  })

  it('removes its abort listener when it resolves', async () => {
    const app = createTestContainer()
    provide(app, 'airi.llm', () => 'llm')
    await start(app)
    const { signal, listeners } = trackedController()

    await expect(resolve(app, { llm: 'airi.llm' }, { signal })).resolves.toEqual({ llm: 'llm' })
    expect(listeners()).toBe(0)
  })

  it('rejects invalid options', () => {
    const app = createTestContainer()
    expect(() => resolve(app, {}, { signal: 'soon' as unknown as AbortSignal })).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
  })
})
