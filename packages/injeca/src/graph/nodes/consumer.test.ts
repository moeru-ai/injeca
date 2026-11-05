import type { OwnerRecord } from '../../types'

import { describe, expect, it, vi } from 'vitest'

import { dispose, graph, provide, resolve, start, stop } from '../../scoped'
import { createTestContainer, drained, phaseOf } from '../../testing/helpers'

function hostClient() {
  const root = createTestContainer({ owner: { kind: 'host' } })
  const builds: (OwnerRecord | undefined)[] = []
  const disposed: (OwnerRecord | undefined)[] = []
  const client = provide(root, 'host.client', {
    perConsumer: true,
    metadata: { api: 'v1' },
    build: ({ consumer, effect }) => {
      builds.push(consumer)
      effect(() => () => {
        disposed.push(consumer)
      })
      return { owner: consumer }
    },
  })

  return { root, client, builds, disposed }
}

describe('perConsumer', () => {
  it('builds once for each consumer container, and disposes with that container (design test 13)', async () => {
    const { root, client, builds, disposed } = hostClient()
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    const b = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'b' } })
    const seen: unknown[] = []
    provide(a, 'a.one', { dependsOn: { client }, build: ({ dependsOn }) => seen.push(['a.one', dependsOn.client.owner]) })
    provide(a, 'a.two', { dependsOn: { client }, build: ({ dependsOn }) => seen.push(['a.two', dependsOn.client.owner]) })
    provide(b, 'b.one', { dependsOn: { client }, build: ({ dependsOn }) => seen.push(['b.one', dependsOn.client.owner]) })
    await start(root)
    await start(a)
    await start(b)

    expect(builds).toEqual([{ kind: 'extension', id: 'a' }, { kind: 'extension', id: 'b' }])
    expect(seen).toEqual([
      ['a.one', { kind: 'extension', id: 'a' }],
      ['a.two', { kind: 'extension', id: 'a' }],
      ['b.one', { kind: 'extension', id: 'b' }],
    ])
    expect(graph(root).services().filter(service => service.key === 'host.client').map(service => service.consumer)).toEqual([
      undefined,
      { kind: 'extension', id: 'a' },
      { kind: 'extension', id: 'b' },
    ])

    await dispose(a)
    expect(disposed).toEqual([{ kind: 'extension', id: 'a' }])
    expect(phaseOf(b, 'b.one')).toBe('running')
  })

  it('does not keep start() waiting for the registration, and builds for resolve() in the root', async () => {
    const { root, builds } = hostClient()
    await start(root)
    expect(builds).toEqual([])

    await expect(resolve(root, { client: 'host.client' })).resolves.toEqual({ client: { owner: { kind: 'host' } } })
    expect(builds).toEqual([{ kind: 'host' }])
  })

  it('withdraws each consumer service with the registration', async () => {
    const { root, client, disposed } = hostClient()
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    provide(a, 'a.one', { dependsOn: { client }, build: () => 'one' })
    await start(root)
    await start(a)

    await expect(client.withdraw()).resolves.toBe(true)
    await drained(root)
    expect(disposed).toEqual([{ kind: 'extension', id: 'a' }])
    expect(phaseOf(a, 'a.one')).toBe('pending')
    await stop(a)
  })

  it('replaces each running consumer service without a gap', async () => {
    const { root, client } = hostClient()
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    const values: unknown[] = []
    provide(a, 'a.one', {
      dependsOn: { client },
      build: ({ dependsOn, on }) => {
        values.push(dependsOn.client)
        on('dependency-change', ({ dependsOn: current, decide }) => {
          values.push(current.client.value)
          return decide.handled()
        })
        return 'one'
      },
    })
    await start(root)
    await start(a)

    const build = vi.fn(({ consumer }: { consumer?: OwnerRecord }) => ({ owner: consumer, version: 2 }))
    await expect(client.replace(build)).resolves.toBe(true)
    await drained(root)
    expect(build).toHaveBeenCalledTimes(1)
    expect(values).toEqual([{ owner: { kind: 'extension', id: 'a' } }, { owner: { kind: 'extension', id: 'a' }, version: 2 }])
    expect(phaseOf(a, 'a.one')).toBe('running')
  })
})
