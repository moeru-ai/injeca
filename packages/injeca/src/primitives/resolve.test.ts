import type { Container } from '../types'

import { describe, expect, it } from 'vitest'

import { WaitTimeoutError } from '../diagnostics/errors'
import { nodeOf } from '../graph/nodes'
import { graph, resolve, start } from '../scoped'
import { createTestContainer, drained, manualClock } from '../testing/helpers'

/** The internal services of a container, with the hidden resolvers of `resolve` calls. */
function nodeServices(container: Container) {
  return nodeOf(container).services
}

describe('resolve bounds (G4)', () => {
  it('rejects after timeoutMs on the container clock and removes its hidden resolver', async () => {
    const { clock, advance, pending } = manualClock()
    const app = createTestContainer({ clock })
    await start(app)

    const timed = resolve(app, { llm: 'airi.llm' }, { timeoutMs: 50 }).catch((error: unknown) => error)
    await drained(app)
    expect(pending()).toBe(1)
    advance(50)
    expect(await timed).toBeInstanceOf(WaitTimeoutError)
    await drained(app)
    expect(pending()).toBe(0)
    expect(graph(app).services()).toEqual([])
    expect([...nodeServices(app)]).toEqual([])
  })

  it('rejects with the abort reason, also when the signal aborted before the call', async () => {
    const app = createTestContainer()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const waiting = resolve(app, { llm: 'airi.llm' }, { signal: controller.signal })
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    await expect(resolve(app, { llm: 'airi.llm' }, { signal: controller.signal })).rejects.toBe(reason)
    await drained(app)
    expect([...nodeServices(app)]).toEqual([])
  })

  it('rejects invalid options', () => {
    const app = createTestContainer()
    expect(() => resolve(app, {}, { timeoutMs: -1 })).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
  })
})
