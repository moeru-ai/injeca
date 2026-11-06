import type { ProviderInfo } from '../../types'

import { describe, expect, it, vi } from 'vitest'

import { defineKey, firstAvailable, graph, optional, peek, provide, resolve, start, where } from '../../scoped'
import { collectRecords, createTestContainer, drained, phaseOf } from '../../testing/helpers'

const boardKey = defineKey<string>('dev.airi.whiteboard')
const major = (provider: ProviderInfo): number => Number(String(provider.metadata.version ?? '0').split('.')[0])

describe('resolution conditions', () => {
  it('keeps a required dependent pending when the condition rejects the provider, and explain names it (design test 16)', async () => {
    const root = createTestContainer()
    const plugin = createTestContainer({ parent: root, owner: { kind: 'plugin', id: 'whiteboard-b' } })
    const condition = vi.fn((provider: ProviderInfo) => major(provider) >= 2)
    provide(plugin, boardKey, { metadata: { version: '1.4.0' }, build: () => 'v1' })
    provide(plugin, 'whiteboard.panel', { dependsOn: { board: where(boardKey, condition) }, build: ({ dependsOn }) => dependsOn.board })
    await start(root)
    void start(plugin)
    await drained(root)

    expect(phaseOf(plugin, 'whiteboard.panel')).toBe('pending')
    expect(condition).toHaveBeenCalledWith({ key: 'dev.airi.whiteboard', owner: { kind: 'plugin', id: 'whiteboard-b' }, metadata: { version: '1.4.0' } })
    expect(graph(plugin).explain('whiteboard.panel')?.blockers).toEqual([
      { kind: 'rejected-provider', dependency: 'board', key: 'dev.airi.whiteboard', owner: { kind: 'plugin', id: 'whiteboard-b' }, metadata: { version: '1.4.0' } },
    ])
    expect(graph(plugin).dependencies('whiteboard.panel')).toEqual([expect.objectContaining({ name: 'board', conditional: true, resolution: 'rejected' })])
  })

  it('resolves a provider that the condition accepts', async () => {
    const app = createTestContainer()
    provide(app, boardKey, { metadata: { version: '2.1.0' }, build: () => 'v2' })
    await expect(resolve(app, { board: where(boardKey, provider => major(provider) >= 2) })).resolves.toEqual({ board: 'v2' })
  })

  it('gives undefined for a rejected optional dependency, in both combinations', async () => {
    const app = createTestContainer()
    provide(app, boardKey, { metadata: { version: '1.0.0' }, build: () => 'v1' })
    const atLeastTwo = (provider: ProviderInfo): boolean => major(provider) >= 2

    await expect(resolve(app, {
      wrapped: optional(where(boardKey, atLeastTwo)),
      inner: where(optional(boardKey), atLeastTwo),
      accepted: optional(where(boardKey, () => true)),
    })).resolves.toEqual({ wrapped: undefined, inner: undefined, accepted: { value: 'v1', status: 'ready' } })
  })

  it('counts a thrown error as false and sends it to the observe stream', async () => {
    const app = createTestContainer()
    const { records } = collectRecords(app)
    const error = new Error('bad range')
    provide(app, boardKey, () => 'board')
    provide(app, 'whiteboard.panel', {
      dependsOn: {
        board: where(boardKey, () => {
          throw error
        }),
      },
      build: () => 'panel',
    })
    void start(app)
    await drained(app)

    expect(phaseOf(app, 'whiteboard.panel')).toBe('pending')
    expect(records.filter(record => record.type === 'error')).toEqual([
      expect.objectContaining({ type: 'error', key: 'whiteboard.panel', error }),
    ])
  })

  it('filters the candidates of firstAvailable, selects the first candidate that passes, and explain names each rejected candidate', async () => {
    const app = createTestContainer()
    provide(app, 'llm.remote', { metadata: { version: '1.0.0' }, build: () => 'remote v1' })
    provide(app, 'llm.local', { metadata: { version: '1.2.0' }, build: () => 'local v1' })
    const atLeastTwo = (provider: ProviderInfo): boolean => major(provider) >= 2
    provide(app, 'chat', { dependsOn: { llm: where(firstAvailable('llm.remote', 'llm.local'), atLeastTwo) }, build: ({ dependsOn }) => dependsOn.llm })
    void start(app)
    await drained(app)

    expect(phaseOf(app, 'chat')).toBe('pending')
    expect(graph(app).explain('chat').blockers).toEqual([
      { kind: 'rejected-provider', dependency: 'llm', key: 'llm.remote', owner: {}, metadata: { version: '1.0.0' } },
      { kind: 'rejected-provider', dependency: 'llm', key: 'llm.local', owner: {}, metadata: { version: '1.2.0' } },
    ])
    expect(peek(app, where(firstAvailable('llm.remote', 'llm.local'), atLeastTwo))).toMatchObject({ kind: 'rejected', key: 'llm.remote' })

    // A condition on one candidate filters only that candidate. The order of where() and firstAvailable() has no effect on the others.
    await expect(resolve(app, {
      inner: firstAvailable(where('llm.remote', atLeastTwo), 'llm.local'),
      optionalInner: optional(firstAvailable(where('llm.remote', atLeastTwo), 'llm.local')),
      optionalOuter: optional(where(firstAvailable('llm.remote', 'llm.local'), atLeastTwo)),
      outerOptional: where(optional(firstAvailable('llm.remote', 'llm.local')), atLeastTwo),
    })).resolves.toEqual({
      inner: 'local v1',
      optionalInner: { value: 'local v1', status: 'ready' },
      optionalOuter: undefined,
      outerOptional: undefined,
    })

    provide(app, 'llm.local.v2', { metadata: { version: '2.0.0' }, build: () => 'local v2' })
    await expect(resolve(app, { llm: where(firstAvailable('llm.remote', 'llm.local', 'llm.local.v2'), atLeastTwo) })).resolves.toEqual({ llm: 'local v2' })
  })
})
