import type { Deferred } from '../../testing/helpers'
import type { OwnerRecord } from '../../types'

import { describe, expect, it, vi } from 'vitest'

import { waitFor } from '../../queries/watch'
import { dispose, graph, provide, resolve, start, stop, transaction } from '../../scoped'
import { createTestContainer, deferred, drained, phaseOf } from '../../testing/helpers'

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

describe('perConsumer replace (B1)', () => {
  it('swaps no consumer when one consumer build fails, and keeps the old template and instances', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const client = provide(root, 'host.client', { perConsumer: true, build: ({ consumer }) => ({ owner: consumer, version: 1 }) })
    const good = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'good' } })
    const bad = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'bad' } })
    await start(root)
    await start(good)
    await start(bad)
    await resolve(good, { client })
    await resolve(bad, { client })
    const before = graph(root).services().filter(service => service.key === 'host.client').map(service => service.instanceId)

    const successorStop = vi.fn()
    const failBad = deferred()
    const replaced = client.replace(async ({ consumer, on }) => {
      if (consumer?.id === 'bad') {
        await failBad.promise
        throw new Error('boom')
      }
      on('stop', successorStop)
      return { owner: consumer, version: 2 }
    })
    replaced.catch(() => {})
    await drained(root)
    // The successor of the good consumer completed start. It waits for the other consumer.
    await expect(resolve(good, { client })).resolves.toEqual({ client: { owner: { kind: 'extension', id: 'good' }, version: 1 } })
    failBad.resolve()
    await expect(replaced).rejects.toThrow('boom')
    await drained(root)

    // No consumer moved. The successor of the good consumer started, then stopped again.
    expect(successorStop).toHaveBeenCalledTimes(1)
    await expect(resolve(good, { client })).resolves.toEqual({ client: { owner: { kind: 'extension', id: 'good' }, version: 1 } })
    await expect(resolve(bad, { client })).resolves.toEqual({ client: { owner: { kind: 'extension', id: 'bad' }, version: 1 } })
    expect(graph(root).services().filter(service => service.key === 'host.client').map(service => service.instanceId)).toEqual(before)

    // A new consumer still builds from the old template.
    const late = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'late' } })
    await start(late)
    await expect(resolve(late, { client })).resolves.toEqual({ client: { owner: { kind: 'extension', id: 'late' }, version: 1 } })
  })

  it('swaps every consumer in one batch after each successor completes start', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const gates = new Map<string, Deferred>([['a', deferred()], ['b', deferred()]])
    const client = provide(root, 'host.client', { perConsumer: true, build: ({ consumer }) => ({ owner: consumer, version: 1 }) })
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    const b = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'b' } })
    const seen: string[] = []
    for (const container of [a, b]) {
      provide(container, 'user', {
        dependsOn: { client },
        build: ({ dependsOn }) => {
          seen.push(`${String(dependsOn.client.owner?.id)}:v${dependsOn.client.version}`)
          return 'user'
        },
      })
    }
    await start(root)
    await start(a)
    await start(b)
    seen.length = 0

    const replaced = client.replace(({ consumer, on }) => {
      on('start', () => gates.get(String(consumer?.id))!.promise)
      return { owner: consumer, version: 2 }
    })
    gates.get('a')!.resolve()
    await drained(root)
    // The successor of `a` completed start, but it waits for `b`. No dependent moved.
    expect(seen).toEqual([])

    gates.get('b')!.resolve()
    await expect(replaced).resolves.toBe(true)
    await drained(root)
    expect(seen.sort()).toEqual(['a:v2', 'b:v2'])
  })
})

describe('perConsumer replace (B1), cancellation and transactions', () => {
  it('resolves false when a newer replace supersedes it, and stops the waiting successors', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const client = provide(root, 'host.client', { perConsumer: true, build: () => 'v1' })
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    await start(root)
    await start(a)
    await resolve(a, { client })

    const firstStop = vi.fn()
    const never = deferred()
    const first = client.replace(({ on }) => {
      on('start', () => never.promise)
      on('stop', firstStop)
      return 'v2'
    })
    await drained(root)
    const second = client.replace(() => 'v3')
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    await drained(root)
    expect(firstStop).toHaveBeenCalledTimes(1)
    await expect(resolve(a, { client })).resolves.toEqual({ client: 'v3' })
  })

  it('keeps the old consumer services when a tx.replace fails for one consumer', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const client = provide(root, 'host.client', { perConsumer: true, build: ({ consumer }) => `v1:${String(consumer?.id)}` })
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    const b = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'b' } })
    await start(root)
    await start(a)
    await start(b)
    await resolve(a, { client })
    await resolve(b, { client })

    const tx = transaction(root)
    tx.replace(client, ({ consumer }) => {
      if (consumer?.id === 'b')
        throw new Error('boom')
      return `v2:${String(consumer?.id)}`
    })
    await tx.commit()
    await drained(root)
    await expect(resolve(a, { client })).resolves.toEqual({ client: 'v1:a' })
    await expect(resolve(b, { client })).resolves.toEqual({ client: 'v1:b' })
  })
})

describe('a failed consumer service (G6)', () => {
  it('builds again on the next demand from its container', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    let allow = false
    const client = provide(root, 'host.client', {
      perConsumer: true,
      build: ({ consumer }) => {
        if (!allow)
          throw new Error('permission-denied')
        return { owner: consumer }
      },
    })
    await start(root)
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'e' } })
    await start(extension)

    await expect(resolve(extension, { client })).rejects.toThrow('permission-denied')
    allow = true
    // A new resolve call is a new demand. The failed consumer service builds again.
    await expect(resolve(extension, { client })).resolves.toEqual({ client: { owner: { kind: 'extension', id: 'e' } } })
  })

  it('does not build again for a dependent that already waits, so no retry loop starts', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const build = vi.fn(() => {
      throw new Error('denied')
    })
    const client = provide(root, 'host.client', { perConsumer: true, build })
    await start(root)
    const extension = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'e' } })
    provide(extension, 'user', { dependsOn: { client }, build: () => 'user' })
    void start(extension).catch(() => {})
    await drained(root)
    expect(build).toHaveBeenCalledTimes(1)

    // A new demand from a waitFor subscription builds again once.
    await expect(waitFor(extension, client)).rejects.toMatchObject({ code: 'service-failed' })
    await drained(root)
    expect(build).toHaveBeenCalledTimes(2)
  })
})
