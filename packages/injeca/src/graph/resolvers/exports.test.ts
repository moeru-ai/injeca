import { describe, expect, it } from 'vitest'

import { InvalidArgumentError } from '../../diagnostics/errors'
import { observe } from '../../queries/observe'
import { waitFor, watch } from '../../queries/watch'
import { defineKey, dispose, graph, peek, provide, resolve, start, transaction } from '../../scoped'
import { createTestContainer, deferred, drained, phaseOf, stateOf } from '../../testing/helpers'

const kitKey = defineKey<string>('kit.x', { exclusive: true })
const plainKey = defineKey<string>('kit.plain')

/** The plugin host of probe P1: a root container with two plugin containers. */
function host() {
  const root = createTestContainer({ owner: { kind: 'host' } })
  const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
  const b = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'b' } })
  return { root, a, b }
}

describe('exported registrations', () => {
  it('makes a child registration visible to the parent and to the siblings (probe P1)', async () => {
    const { root, a, b } = host()
    provide(a, kitKey, { export: true, build: () => 'from-a' })
    const values: string[] = []
    const inRoot = provide(root, 'root:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => values.push(`root:${dependsOn.k}`) })
    provide(b, 'b:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => values.push(`b:${dependsOn.k}`) })
    await start(root)
    await start(a)
    await start(b)

    expect(phaseOf(root, inRoot)).toBe('running')
    expect(phaseOf(b, 'b:consumer')).toBe('running')
    expect(values.sort()).toEqual(['b:from-a', 'root:from-a'])
    // The registration lives in its own container.
    expect(graph(root).explain(kitKey)).toMatchObject({ owner: { kind: 'extension', id: 'a' }, phase: 'running' })
    expect(graph(b).explain(kitKey)).toMatchObject({ owner: { kind: 'extension', id: 'a' } })
    expect(graph(root).services().find(service => service.key === 'kit.x')).toMatchObject({ owner: { kind: 'extension', id: 'a' }, exported: true })
    expect(graph(root).dependents(kitKey).map(service => service.key).sort()).toEqual(['b:consumer', 'root:consumer'])
    expect(graph(b).dependencies('b:consumer')[0]).toMatchObject({ resolution: 'resolved', provider: { owner: { kind: 'extension', id: 'a' } } })
  })

  it('keeps a registration without export invisible to the parent and to the siblings', async () => {
    const { root, a, b } = host()
    provide(a, kitKey, () => 'from-a')
    provide(root, 'root:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => dependsOn.k })
    provide(b, 'b:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => dependsOn.k })
    void start(root)
    void start(a)
    void start(b)
    await drained(root)

    expect(phaseOf(root, 'root:consumer')).toBe('pending')
    expect(phaseOf(b, 'b:consumer')).toBe('pending')
    expect(graph(root).explain('root:consumer').blockers).toEqual([{ kind: 'missing-provider', dependency: 'k', key: 'kit.x' }])
    expect(graph(root).services().find(service => service.key === 'kit.x')).toMatchObject({ exported: false })
  })

  it('exports exactly one level up', async () => {
    const root = createTestContainer()
    const middle = createTestContainer({ parent: root })
    const leaf = createTestContainer({ parent: middle })
    const sibling = createTestContainer({ parent: middle })
    provide(leaf, plainKey, { export: true, build: () => 'leaf' })
    provide(root, 'root:consumer', { dependsOn: { k: plainKey }, build: ({ dependsOn }) => dependsOn.k })
    provide(middle, 'middle:consumer', { dependsOn: { k: plainKey }, build: ({ dependsOn }) => dependsOn.k })
    provide(sibling, 'sibling:consumer', { dependsOn: { k: plainKey }, build: ({ dependsOn }) => dependsOn.k })
    void start(root)
    void start(middle)
    void start(leaf)
    void start(sibling)
    await drained(root)

    expect(phaseOf(middle, 'middle:consumer')).toBe('running')
    expect(phaseOf(sibling, 'sibling:consumer')).toBe('running')
    // The export reaches the area of `middle`, not the area of `root`.
    expect(phaseOf(root, 'root:consumer')).toBe('pending')
    expect(peek(root, plainKey)).toMatchObject({ kind: 'missing' })
  })

  it('has no effect on a root container', async () => {
    const root = createTestContainer()
    provide(root, plainKey, { export: true, build: () => 'root' })
    await start(root)
    expect(peek(root, plainKey)).toMatchObject({ kind: 'resolved', value: 'root' })
  })

  it('rejects an export option that is not a boolean', () => {
    const { a } = host()
    expect(() => provide(a, plainKey, { export: 'yes' as unknown as boolean, build: () => 'a' })).toThrow(InvalidArgumentError)
  })

  it('puts the own registration of an ancestor before the exports of its children, without a gap', async () => {
    const { root, a, b } = host()
    const rootStart = deferred()
    const values: string[] = []
    provide(a, plainKey, { export: true, build: () => 'from-a' })
    provide(b, 'b:consumer', {
      dependsOn: { k: plainKey },
      build: ({ dependsOn, on }) => {
        values.push(dependsOn.k)
        on('dependency-change', ({ dependsOn: current, decide }) => {
          values.push(current.k.value)
          return decide.handled()
        })
        return 'consumer'
      },
    })
    await start(root)
    await start(a)
    await start(b)
    expect(values).toEqual(['from-a'])

    // The own registration of `root` comes first. It takes over only when it runs.
    const own = provide(root, plainKey, ({ on }) => {
      on('start', () => rootStart.promise)
      return 'from-root'
    })
    await drained(root)
    expect(values).toEqual(['from-a'])
    rootStart.resolve()
    await drained(root)
    expect(values).toEqual(['from-a', 'from-root'])
    expect(stateOf(b, plainKey).instanceId).toBe(stateOf(root, plainKey).instanceId)

    await own.withdraw()
    await drained(root)
    expect(values).toEqual(['from-a', 'from-root', 'from-a'])
  })

  it('shadows a provider of a farther ancestor only while it runs', async () => {
    const root = createTestContainer()
    const middle = createTestContainer({ parent: root })
    const exporter = createTestContainer({ parent: middle })
    const consumer = createTestContainer({ parent: middle })
    const exportStart = deferred()
    const values: string[] = []
    provide(root, plainKey, () => 'from-root')
    provide(consumer, 'consumer', {
      dependsOn: { k: plainKey },
      build: ({ dependsOn, on }) => {
        values.push(dependsOn.k)
        on('dependency-change', ({ dependsOn: current, decide }) => {
          values.push(current.k.value)
          return decide.handled()
        })
        return 'consumer'
      },
    })
    await start(root)
    await start(middle)
    await start(consumer)
    await start(exporter)

    const exported = provide(exporter, plainKey, {
      export: true,
      build: ({ on }) => {
        on('start', () => exportStart.promise)
        return 'from-export'
      },
    })
    await drained(root)
    expect(values).toEqual(['from-root'])
    exportStart.resolve()
    await drained(root)
    expect(values).toEqual(['from-root', 'from-export'])

    await exported.withdraw()
    await drained(root)
    expect(values).toEqual(['from-root', 'from-export', 'from-root'])
  })

  it('stops the dependents in other containers when the exporting container is disposed, and impact previews it', async () => {
    const { root, a, b } = host()
    provide(a, kitKey, { export: true, build: () => 'from-a' })
    provide(b, 'b:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => dependsOn.k })
    await start(root)
    await start(a)
    await start(b)

    const impact = graph(root).impact({ kind: 'dispose', container: a })
    expect(impact.stopped.map(service => service.key).sort()).toEqual(['b:consumer', 'kit.x'])
    expect(graph(root).impact({ kind: 'withdraw', key: kitKey }).stopped.map(service => service.key).sort()).toEqual(['b:consumer', 'kit.x'])
    expect(phaseOf(b, 'b:consumer')).toBe('running')

    await dispose(a)
    await drained(root)
    expect(phaseOf(b, 'b:consumer')).toBe('pending')
    expect(peek(b, kitKey)).toMatchObject({ kind: 'missing' })
  })

  it('moves the dependents to the new instance when an exported registration is replaced', async () => {
    const { root, a, b } = host()
    const kit = provide(a, plainKey, { export: true, build: () => 'v1' })
    const values: string[] = []
    provide(b, 'b:consumer', { dependsOn: { k: plainKey }, build: ({ dependsOn }) => values.push(dependsOn.k) })
    await start(root)
    await start(a)
    await start(b)

    await expect(kit.replace({ build: () => 'v2' })).resolves.toBe(true)
    await drained(root)
    expect(values).toEqual(['v1', 'v2'])
    expect(graph(root).services().find(service => service.key === 'kit.plain')).toMatchObject({ exported: true })
  })

  it('reports an export to peek, watch, waitFor, and observe of the parent area', async () => {
    const { root, a, b } = host()
    const records: string[] = []
    observe(root, (record) => {
      if (record.key === 'kit.plain' && record.type === 'phase')
        records.push(`${String(record.owner.id)}:${record.to}`)
    })
    const states: string[] = []
    const stopWatch = watch(b, plainKey, state => states.push(state.phase ?? 'missing'))
    const ready = waitFor(b, plainKey)

    provide(a, plainKey, { export: true, build: () => 'from-a' })
    await start(a)
    await ready
    await drained(root)

    expect(peek(b, plainKey)).toMatchObject({ kind: 'resolved', value: 'from-a', owner: { kind: 'extension', id: 'a' } })
    expect(peek(root, plainKey)).toMatchObject({ kind: 'resolved', value: 'from-a' })
    expect(states.at(-1)).toBe('running')
    expect(records).toContain('a:running')
    stopWatch()
  })

  it('builds a perConsumer export for each consumer container', async () => {
    const { root, a, b } = host()
    const builds: unknown[] = []
    provide(a, 'kit.client', {
      export: true,
      perConsumer: true,
      build: ({ consumer }) => {
        builds.push(consumer)
        return { consumer }
      },
    })
    provide(b, 'b:consumer', { dependsOn: { client: 'kit.client' }, build: ({ dependsOn }) => dependsOn.client })
    provide(root, 'root:consumer', { dependsOn: { client: 'kit.client' }, build: ({ dependsOn }) => dependsOn.client })
    await start(root)
    await start(a)
    await start(b)

    expect(builds).toEqual(expect.arrayContaining([{ kind: 'host' }, { kind: 'extension', id: 'b' }]))
    expect(builds).toHaveLength(2)
    // The consumer instance lives in the consumer container, so it disposes with it. The registration stays in `a`.
    expect(graph(b).services().find(service => service.key === 'kit.client')).toMatchObject({ owner: { kind: 'extension', id: 'b' }, consumer: { kind: 'extension', id: 'b' } })
    await dispose(b)
    expect(graph(a).services().find(service => service.key === 'kit.client')).toMatchObject({ owner: { kind: 'extension', id: 'a' }, perConsumer: true, exported: true })
    expect(phaseOf(root, 'root:consumer')).toBe('running')
  })

  it('resolves the dependencies of a perConsumer export from the exporting container, and keeps consumer in the build context', async () => {
    const { root, a, b } = host()
    provide(a, 'runtime', () => 'runtime of a')
    provide(b, 'runtime', () => 'runtime of b')
    provide(b, 'kit', {
      export: true,
      perConsumer: true,
      dependsOn: { runtime: 'runtime' },
      build: ({ dependsOn, consumer }) => ({ runtime: dependsOn.runtime, consumer }),
    })
    await start(root)
    await start(a)
    await start(b)

    // The instance lives in `a`, but `build` runs for the registration in `b`, so `runtime` is the one of `b`.
    await expect(resolve(a, { kit: 'kit' }, { timeoutMs: 500 })).resolves.toEqual({ kit: { runtime: 'runtime of b', consumer: { kind: 'extension', id: 'a' } } })
    expect(graph(a).dependencies('kit')[0]).toMatchObject({ resolution: 'resolved', provider: { owner: { kind: 'extension', id: 'b' } } })
  })
})

describe('exported exclusive keys', () => {
  it('puts two sibling exports of one exclusive key in conflict, in either order (probe P1)', async () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const { root, a, b } = host()
      const containers = { a, b }
      await start(root)
      await start(a)
      await start(b)
      const registrations = order.map(id => provide(containers[id], kitKey, { export: true, build: () => id }))
      await drained(root)

      expect(phaseOf(a, kitKey)).toBe('conflict')
      expect(phaseOf(b, kitKey)).toBe('conflict')
      expect(peek(root, kitKey)).toMatchObject({ kind: 'conflict', owners: [{ kind: 'extension', id: 'a' }, { kind: 'extension', id: 'b' }] })

      // When one declaration leaves, the other converges.
      await registrations[0]!.withdraw()
      await drained(root)
      expect(peek(root, kitKey)).toMatchObject({ kind: 'resolved', value: order[1] })
    }
  })

  it('puts a parent registration and a child export of one exclusive key in conflict', async () => {
    const { root, a } = host()
    provide(root, kitKey, () => 'root')
    provide(a, kitKey, { export: true, build: () => 'a' })
    void start(root)
    void start(a)
    await drained(root)

    expect(phaseOf(root, kitKey)).toBe('conflict')
    expect(phaseOf(a, kitKey)).toBe('conflict')
    expect(graph(root).explain(kitKey).blockers).toContainEqual({ kind: 'conflict', key: 'kit.x', owners: [{ kind: 'host' }, { kind: 'extension', id: 'a' }] })
  })

  it('puts an export and a registration of a sibling without export in conflict', async () => {
    const { root, a, b } = host()
    provide(a, kitKey, { export: true, build: () => 'a' })
    provide(b, kitKey, () => 'b')
    void start(root)
    void start(a)
    void start(b)
    await drained(root)

    expect(phaseOf(a, kitKey)).toBe('conflict')
    expect(phaseOf(b, kitKey)).toBe('conflict')
  })

  it('reserves an exported exclusive key of a transaction in the parent area until the commit or the abort', async () => {
    const { root, a, b } = host()
    await start(root)
    await start(a)
    await start(b)
    provide(b, kitKey, { export: true, build: () => 'b' })
    provide(root, 'root:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => dependsOn.k })
    await drained(root)
    expect(phaseOf(root, 'root:consumer')).toBe('running')

    const tx = transaction(a)
    tx.provide(kitKey, { export: true, build: () => 'a' })
    await drained(root)
    // The reservation counts in the parent area at once, so the export of `b` goes to conflict.
    expect(phaseOf(b, kitKey)).toBe('conflict')
    expect(graph(root).services().find(service => service.key === 'kit.x' && service.phase === 'declared')).toMatchObject({ owner: { kind: 'extension', id: 'a' }, exported: true })

    await tx.abort()
    await drained(root)
    expect(phaseOf(b, kitKey)).toBe('running')
    expect(phaseOf(root, 'root:consumer')).toBe('running')
  })

  it('moves the reservation of a declared key to the parent area while a tx.provide exports it', async () => {
    const { root, a, b } = host()
    await start(root)
    await start(a)
    await start(b)
    provide(b, kitKey, () => 'b')
    await drained(root)

    const tx = transaction(a)
    tx.declare(kitKey)
    await drained(root)
    // The declaration of `a` and the registration of `b` are in different areas.
    expect(phaseOf(b, kitKey)).toBe('running')

    const provided = tx.provide(kitKey, { export: true, build: () => 'a' })
    await drained(root)
    // The export counts in the area of `root`, and `b` is in that area.
    expect(phaseOf(b, kitKey)).toBe('conflict')

    await expect(provided.withdraw()).resolves.toBe(true)
    await drained(root)
    expect(phaseOf(b, kitKey)).toBe('running')
    await tx.abort()
  })

  it('publishes an export of a transaction to the parent area at the commit', async () => {
    const { root, a, b } = host()
    await start(root)
    await start(a)
    await start(b)
    provide(b, 'b:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => dependsOn.k })

    const tx = transaction(a)
    tx.declare(kitKey)
    tx.provide(kitKey, { export: true, build: () => 'a' })
    await drained(root)
    expect(phaseOf(b, 'b:consumer')).toBe('pending')

    await tx.commit()
    await drained(root)
    expect(phaseOf(b, 'b:consumer')).toBe('running')
    expect(peek(b, kitKey)).toMatchObject({ kind: 'resolved', value: 'a' })
  })
})

describe('exports and key isolation', () => {
  it('hides the exports of the siblings from a container that isolates the key', async () => {
    const root = createTestContainer()
    const a = createTestContainer({ parent: root })
    const isolated = createTestContainer({ parent: root, isolate: [plainKey] })
    provide(a, plainKey, { export: true, build: () => 'a' })
    provide(isolated, 'isolated:consumer', { dependsOn: { k: plainKey }, build: ({ dependsOn }) => dependsOn.k })
    void start(root)
    void start(a)
    void start(isolated)
    await drained(root)

    expect(phaseOf(isolated, 'isolated:consumer')).toBe('pending')
    expect(peek(isolated, plainKey)).toMatchObject({ kind: 'missing' })
  })

  it('accepts the exports of its own children in a container that isolates the key, and keeps them out of the ancestor area', async () => {
    const root = createTestContainer()
    const isolated = createTestContainer({ parent: root, isolate: [kitKey] })
    const child = createTestContainer({ parent: isolated })
    provide(root, kitKey, () => 'root')
    provide(child, kitKey, { export: true, build: () => 'child' })
    provide(isolated, 'isolated:consumer', { dependsOn: { k: kitKey }, build: ({ dependsOn }) => dependsOn.k })
    void start(root)
    void start(isolated)
    void start(child)
    await drained(root)

    expect(peek(isolated, kitKey)).toMatchObject({ kind: 'resolved', value: 'child' })
    expect(phaseOf(isolated, 'isolated:consumer')).toBe('running')
    // The isolated key ends the area of the root key, so the export does not conflict with it.
    expect(peek(root, kitKey)).toMatchObject({ kind: 'resolved', value: 'root' })
  })
})
