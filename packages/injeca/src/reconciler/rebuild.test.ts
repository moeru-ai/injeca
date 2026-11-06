import type { ProvidedBy } from '../types'

import { describe, expect, it } from 'vitest'

import { watch } from '../queries/watch'
import { graph, invoke, optional, peek, provide, resolve, start } from '../scoped'
import { collectRecords, createTestContainer, drained, stateOf } from '../testing/helpers'

/** A chain `leaf` <- `middle` <- `top`. `middle` has no handler. `events` records each build, start, stop, and dependency change. */
function chain(topHandler: boolean) {
  const app = createTestContainer()
  const events: string[] = []
  const leaf = provide(app, 'leaf', () => 1)
  provide(app, 'middle', {
    dependsOn: { leaf: 'leaf' },
    build: ({ dependsOn, on, instanceId }) => {
      events.push(`middle build ${dependsOn.leaf}`)
      on('start', () => void events.push(`middle start ${dependsOn.leaf}`))
      on('stop', () => void events.push(`middle stop ${dependsOn.leaf}`))
      void instanceId
      return dependsOn.leaf
    },
  })
  provide(app, 'top', {
    dependsOn: { middle: 'middle' },
    build: ({ dependsOn, on }) => {
      events.push(`top build ${dependsOn.middle}`)
      on('stop', () => void events.push(`top stop ${dependsOn.middle}`))
      if (topHandler) {
        on('dependency-change', ({ changes, decide }) => {
          for (const change of changes)
            events.push(`top change ${change.from?.instanceId ?? 'none'} -> ${change.to?.instanceId ?? 'withdrawn'}`)
          return decide.handled()
        })
      }
      return 'top'
    },
  })

  return { app, leaf, events }
}

describe('make-before-break rebuild', () => {
  it('builds and starts the successor of an intermediate service before the old one stops, so a dependent sees an identity change', async () => {
    const { app, leaf, events } = chain(true)
    await start(app)
    const oldMiddle = stateOf(app, 'middle').instanceId
    const { records } = collectRecords(app)
    events.length = 0

    await leaf.replace(() => 2)
    await drained(app)
    const newMiddle = stateOf(app, 'middle').instanceId

    expect(newMiddle).not.toBe(oldMiddle)
    expect(events).toEqual([
      'middle build 2',
      'middle start 2',
      `top change ${oldMiddle} -> ${newMiddle}`,
      'middle stop 1',
    ])
    expect(stateOf(app, 'top')).toMatchObject({ phase: 'running', status: 'ready' })
    // Neither `middle` nor `top` leaves `running`. Only the old instance of `middle` stops.
    expect(records.filter(record => record.type === 'phase' && record.key === 'top' && record.from !== undefined)).toEqual([])
    expect(records.filter(record => record.type === 'phase' && record.key === 'middle' && record.to === 'pending')).toEqual([])
  })

  it('rebuilds each dependent without a handler make-before-break too', async () => {
    const { app, leaf, events } = chain(false)
    await start(app)
    events.length = 0

    await leaf.replace(() => 2)
    await drained(app)

    expect(events).toEqual([
      'middle build 2',
      'middle start 2',
      'top build 2',
      'top stop 1',
      'middle stop 1',
    ])
    expect(stateOf(app, 'top').phase).toBe('running')
  })

  it('rebuilds make-before-break for decide.rebuild from a dependency hook', async () => {
    const app = createTestContainer()
    const events: string[] = []
    const llm = provide(app, 'llm', () => 'v1')
    provide(app, 'speech', {
      dependsOn: { llm },
      build: ({ dependsOn, on }) => {
        events.push(`build ${dependsOn.llm}`)
        on('stop', () => void events.push(`stop ${dependsOn.llm}`))
        on('dependency-change', ({ decide }) => decide.rebuild())
        return dependsOn.llm
      },
    })
    await start(app)

    await llm.replace(() => 'v2')
    await drained(app)
    expect(events).toEqual(['build v1', 'build v2', 'stop v1'])
  })

  it('keeps stop-then-build when a bound optional dependency is withdrawn', async () => {
    const app = createTestContainer()
    const events: string[] = []
    const tts = provide(app, 'tts', () => 'tts')
    provide(app, 'speech', {
      dependsOn: { tts: optional(tts) },
      build: ({ dependsOn, on }) => {
        events.push(`build ${dependsOn.tts?.value ?? 'none'}`)
        on('stop', () => void events.push(`stop ${dependsOn.tts?.value ?? 'none'}`))
        return 'speech'
      },
    })
    await start(app)
    await drained(app)
    expect(stateOf(app, 'speech').phase).toBe('running')
    events.length = 0

    await tts.withdraw()
    await drained(app)
    expect(events).toEqual(['stop tts', 'build none'])
  })

  it('stops the old instance and fails the service when the successor fails', async () => {
    const app = createTestContainer()
    const events: string[] = []
    const leaf = provide(app, 'leaf', () => 1)
    provide(app, 'middle', {
      dependsOn: { leaf },
      build: ({ dependsOn, on }) => {
        if (dependsOn.leaf === 2)
          throw new Error('cannot build for 2')
        on('stop', () => void events.push(`stop ${dependsOn.leaf}`))
        return dependsOn.leaf
      },
    })
    await start(app)

    await leaf.replace(() => 2)
    await drained(app)
    expect(events).toEqual(['stop 1'])
    expect(stateOf(app, 'middle').phase).toBe('failed')
    expect(graph(app).explain('middle').blockers).toEqual([{ kind: 'failed', error: new Error('cannot build for 2') }])
  })

  it('keeps stop-then-run for an invocation', async () => {
    const app = createTestContainer()
    const events: string[] = []
    const leaf = provide(app, 'leaf', () => 1)
    invoke(app, {
      dependsOn: { leaf },
      callback: ({ leaf }, { on }) => {
        events.push(`run ${leaf}`)
        on('stop', () => void events.push(`stop ${leaf}`))
      },
    })
    await start(app)

    await leaf.replace(() => 2)
    await drained(app)
    expect(events).toEqual(['run 1', 'stop 1', 'run 2'])
  })

  it('rebuilds a consumer service of a perConsumer registration make-before-break', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    const events: string[] = []
    const leaf = provide(root, 'leaf', () => 1)
    provide(root, 'client', {
      perConsumer: true,
      dependsOn: { leaf },
      build: ({ dependsOn, on, consumer }) => {
        events.push(`client build ${dependsOn.leaf}`)
        on('stop', () => void events.push(`client stop ${dependsOn.leaf}`))
        return { leaf: dependsOn.leaf, consumer }
      },
    })
    provide(a, 'user', {
      dependsOn: { client: 'client' as ProvidedBy<{ leaf: number }> },
      build: ({ dependsOn, on }) => {
        on('dependency-change', ({ dependsOn: current, decide }) => {
          events.push(`user change ${current.client.value.leaf}`)
          return decide.handled()
        })
        return dependsOn.client
      },
    })
    await start(root)
    await start(a)
    events.length = 0

    await leaf.replace(() => 2)
    await drained(root)
    expect(events).toEqual(['client build 2', 'user change 2', 'client stop 1'])
    expect(stateOf(a, 'client').phase).toBe('running')
  })

  it('gives way to a replace() of the registration during the rebuild', async () => {
    const app = createTestContainer()
    const events: string[] = []
    let release = (): void => {}
    const leaf = provide(app, 'leaf', () => 1)
    const middle = provide(app, 'middle', {
      dependsOn: { leaf },
      build: ({ dependsOn, on }) => {
        events.push(`build ${dependsOn.leaf}`)
        if (dependsOn.leaf === 2)
          on('start', () => new Promise<void>(resolve => (release = resolve)))
        return String(dependsOn.leaf)
      },
    })
    await start(app)

    await leaf.replace(() => 2)
    await drained(app)
    expect(events).toEqual(['build 1', 'build 2'])
    expect(graph(app).explain('middle')).toMatchObject({ phase: 'running', replacement: { phase: 'starting' } })

    await expect(middle.replace({ dependsOn: { leaf }, build: ({ dependsOn }) => `replaced ${dependsOn.leaf}` })).resolves.toBe(true)
    release()
    await drained(app)
    expect(stateOf(app, 'middle').phase).toBe('running')
    expect(graph(app).explain('middle')).not.toHaveProperty('replacement')
    await expect(resolve(app, { middle })).resolves.toEqual({ middle: 'replaced 2' })
  })

  it('moves the watch demand of a consumer service to its rebuild successor', async () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const a = createTestContainer({ parent: root, owner: { kind: 'extension', id: 'a' } })
    const leaf = provide(root, 'leaf', () => 1)
    provide(root, 'client', { perConsumer: true, dependsOn: { leaf }, build: ({ dependsOn }) => dependsOn.leaf })
    // Neither container is started. Only the watch demands the consumer service of `a`.
    const phases: string[] = []
    const stopWatch = watch(a, 'client', state => void phases.push(state.phase ?? 'missing'))
    await drained(root)
    expect(stateOf(a, 'client').phase).toBe('running')

    await leaf.replace(() => 2)
    await drained(root)
    expect(peek(a, 'client')).toMatchObject({ kind: 'resolved', value: 2 })

    stopWatch()
    await drained(root)
    expect(peek(a, 'client')).toMatchObject({ kind: 'not-running' })
  })
})
