import { describe, expect, it, vi } from 'vitest'

import { nodeOf } from '../graph/nodes'
import { batch } from '../helpers/signals'
import { optional, provide, start } from '../scoped'
import { createTestContainer, drained, provideWithStatus } from '../testing/helpers'

describe('batches', () => {
  // Design test 30.
  it('notifies each dependent once for many providers that publish together', async () => {
    const app = createTestContainer()
    const calls: string[][] = []
    const builds = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { a: optional('a'), b: optional('b'), c: optional('c') },
      build: ({ on }) => {
        builds()
        on('dependency-change', ({ changes, decide }) => {
          calls.push(changes.map(change => change.key))
          return decide.handled()
        })
        return 'speech'
      },
    })
    await start(app)

    provide(app, 'a', () => 'a')
    provide(app, 'b', () => 'b')
    provide(app, 'c', () => 'c')
    await drained(app)

    expect(builds).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([['a', 'b', 'c']])
  })

  it('marks a dependent dirty once for a batch that changes many providers', async () => {
    const app = createTestContainer()
    const providers = ['a', 'b', 'c'].map(name => provideWithStatus(app, name))
    const calls = vi.fn()
    provide(app, 'voice.speech', {
      dependsOn: { a: 'a', b: 'b', c: 'c' },
      build: ({ on }) => {
        on('dependency-status-change', ({ changes, decide }) => {
          calls(changes.map(change => change.key))
          return decide.handled()
        })
        return 'speech'
      },
    })
    await start(app)

    const { reconciler } = nodeOf(app).runtime
    const markDirty = vi.spyOn(reconciler, 'markDirty')
    batch(() => {
      for (const provider of providers)
        provider.setStatus('degraded')
    })
    const speechNotifications = markDirty.mock.calls.filter(([service]) => service.name === 'voice.speech')
    markDirty.mockRestore()
    await drained(app)

    expect(speechNotifications).toHaveLength(1)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledWith(['a', 'b', 'c'])
  })
})
