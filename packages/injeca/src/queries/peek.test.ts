import type { BuildContext } from '../types'

import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineKey, firstAvailable, graph, peek, provide, start, where } from '../scoped'
import { createTestContainer, drained } from '../testing/helpers'

const llmKey = defineKey<{ chat: () => string }>('airi.llm')

describe('peek (G4)', () => {
  it('reads the value and the status of a running provider now', async () => {
    const app = createTestContainer({ owner: { kind: 'host' } })
    const llm = { chat: () => 'hi' }
    provide(app, llmKey, () => llm)
    await start(app)

    const result = peek(app, llmKey)
    expect(result).toMatchObject({ kind: 'resolved', key: 'airi.llm', owner: { kind: 'host' }, value: llm, status: 'ready' })
    if (result.kind === 'resolved')
      expectTypeOf(result.value).toEqualTypeOf<{ chat: () => string }>()
  })

  it('gives the reason at once, without a wait and without a hidden unit', async () => {
    const app = createTestContainer({ owner: { kind: 'host' } })
    expect(peek(app, llmKey)).toEqual({ kind: 'missing', key: 'airi.llm' })

    let setStatus: BuildContext['setStatus'] = () => {}
    provide(app, llmKey, { metadata: { version: '1.0.0' }, build: (context) => {
      setStatus = context.setStatus
      return { chat: () => 'hi' }
    } })
    expect(peek(app, llmKey)).toMatchObject({ kind: 'not-running', phase: 'pending' })
    expect(peek(app, where(llmKey, ({ metadata }) => metadata.version === '2.0.0'))).toEqual({ kind: 'rejected', key: 'airi.llm', owner: { kind: 'host' }, metadata: { version: '1.0.0' } })

    await start(app)
    setStatus('unavailable', 'reconnecting')
    await drained(app)
    expect(peek(app, llmKey)).toMatchObject({ kind: 'unavailable', reason: 'reconnecting' })
    expect(graph(app).units().map(unit => unit.key)).toEqual(['airi.llm'])
  })

  it('reports a failed provider, a conflict, and the first available fallback', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const child = createTestContainer({ parent: root, owner: { kind: 'extension' } })
    const error = new Error('broken')
    provide(root, 'broken', () => {
      throw error
    })
    const kitKey = defineKey<string>('kit.x', { exclusive: true })
    provide(root, kitKey, () => 'root')
    provide(child, kitKey, () => 'child')
    provide(root, 'local', () => 'local')
    await start(root).catch(() => {})
    await drained(root)

    expect(peek(root, 'broken')).toEqual({ kind: 'not-running', key: 'broken', owner: { kind: 'host' }, phase: 'failed', error })
    expect(peek(child, kitKey)).toEqual({ kind: 'conflict', key: 'kit.x', owners: [{ kind: 'host' }, { kind: 'extension' }] })
    expect(peek(root, firstAvailable('remote', 'local'))).toMatchObject({ kind: 'resolved', key: 'local', value: 'local' })
  })

  it('does not create the unit of a per-container key', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    provide(root, 'host.client', { instances: 'per-container', build: ({ consumer }) => consumer })
    await start(root)
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension' } })
    await start(extension)

    expect(peek(extension, 'host.client')).toMatchObject({ kind: 'not-running', phase: 'pending' })
    expect(graph(extension).units()).toEqual([])
  })
})
