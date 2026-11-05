import { describe, expect, it } from 'vitest'

import { InvalidArgumentError } from '../diagnostics/errors'
import { defineKey, dispose, graph, optional, provide, start } from '../scoped'
import { createTestContainer, drained, stateOf } from '../testing/helpers'

const llmKey = defineKey<string>('airi.llm')

function voiceGraph() {
  const app = createTestContainer()
  const plugin = createTestContainer({ parent: app, owner: { kind: 'plugin', id: 'reaction' } })
  provide(app, llmKey, { metadata: { version: '1.0.0' }, build: () => 'llm' })
  provide(app, 'voice.speech', { dependsOn: { llm: llmKey }, build: () => 'speech' })
  provide(app, 'voice.summary', {
    dependsOn: { speech: 'voice.speech' },
    build: ({ on }) => {
      on('dependency-change', ({ decide }) => decide.handled())
      return 'summary'
    },
  })
  provide(app, 'voice.optional', { dependsOn: { llm: optional(llmKey) }, build: () => 'optional' })
  provide(plugin, 'reaction', { dependsOn: { speech: 'voice.speech' }, build: () => 'reaction' })
  return { app, plugin }
}

describe('graph queries', () => {
  it('lists services, direct edges, and dependents', async () => {
    const { app, plugin } = voiceGraph()
    await start(app)
    await start(plugin)
    const queries = graph(app)

    expect(queries.services().map(service => [service.key, service.owner])).toEqual([
      ['airi.llm', {}],
      ['voice.speech', {}],
      ['voice.summary', {}],
      ['voice.optional', {}],
      ['reaction', { kind: 'plugin', id: 'reaction' }],
    ])
    expect(queries.services()[0]).toMatchObject({ phase: 'running', status: 'ready', metadata: { version: '1.0.0' }, exclusive: false, perConsumer: false })
    expect(queries.dependencies('voice.speech')).toEqual([
      expect.objectContaining({ name: 'llm', keys: ['airi.llm'], optional: false, resolution: 'resolved', provider: expect.objectContaining({ key: 'airi.llm' }) }),
    ])
    expect(queries.dependents('voice.speech').map(service => service.key)).toEqual(['voice.summary', 'reaction'])
    expect(graph(plugin).services().map(service => service.key)).toEqual(['reaction'])
    expect(() => queries.dependencies('')).toThrow(InvalidArgumentError)
  })

  it('orders providers before dependents, and finds cycles', async () => {
    const app = createTestContainer()
    provide(app, 'c', { dependsOn: { b: 'b' }, build: () => 'c' })
    provide(app, 'b', { dependsOn: { a: 'a' }, build: () => 'b' })
    provide(app, 'a', () => 'a')
    provide(app, 'x', { dependsOn: { y: 'y' }, build: () => 'x' })
    provide(app, 'y', { dependsOn: { x: 'x' }, build: () => 'y' })

    expect(graph(app).order().map(service => service.key)).toEqual(['a', 'b', 'c', 'x', 'y'])
    expect(graph(app).order(['b']).map(service => service.key)).toEqual(['a', 'b'])
    expect(graph(app).cycles().map(cycle => cycle.map(service => service.key))).toEqual([['x', 'y']])
  })

  it('reports the services that a proposed change stops, and does not change the real graph (design test 17)', async () => {
    const { app, plugin } = voiceGraph()
    await start(app)
    await start(plugin)
    const before = graph(app).services()

    const withdraw = graph(app).impact({ kind: 'withdraw', key: llmKey })
    expect(withdraw.stopped.map(service => service.key)).toEqual(['airi.llm', 'voice.speech', 'voice.summary', 'reaction'])
    // An optional dependency disappears. The dependent has no handler, so it rebuilds.
    expect(withdraw.rebuilt.map(service => service.key)).toEqual(['voice.optional'])

    const replace = graph(app).impact({ kind: 'replace', key: llmKey })
    expect(replace.stopped).toEqual([])
    expect(replace.rebuilt.map(service => service.key)).toEqual(['voice.speech', 'voice.optional', 'reaction'])
    expect(replace.notified.map(service => service.key)).toEqual(['voice.summary'])

    expect(graph(app).impact({ kind: 'dispose', container: plugin }).stopped.map(service => service.key)).toEqual(['reaction'])

    await drained(app)
    expect(graph(app).services()).toEqual(before)
    expect(stateOf(app, llmKey).phase).toBe('running')
    await dispose(app)
  })

  it('counts an ancestor provider that serves as an alternative', async () => {
    const root = createTestContainer()
    const child = createTestContainer({ parent: root })
    provide(root, llmKey, () => 'root')
    provide(child, llmKey, () => 'child')
    provide(child, 'voice.speech', { dependsOn: { llm: llmKey }, build: () => 'speech' })
    await start(root)
    await start(child)

    const impact = graph(child).impact({ kind: 'withdraw', key: llmKey })
    expect(impact.stopped.map(service => service.owner)).toEqual([{}])
    expect(impact.rebuilt.map(service => service.key)).toEqual(['voice.speech'])
  })

  it('explains a service that waits for a missing provider', async () => {
    const app = createTestContainer()
    provide(app, 'voice.speech', { dependsOn: { llm: llmKey }, build: () => 'speech' })
    void start(app)
    await drained(app)

    expect(graph(app).explain('voice.speech')).toMatchObject({ phase: 'pending', blockers: [{ kind: 'missing-provider', dependency: 'llm', key: 'airi.llm' }] })
    // G4: a key without a service explains the missing provider.
    expect(graph(app).explain('nothing')).toEqual({ name: 'nothing', kind: 'service', owner: {}, phase: undefined, blockers: [{ kind: 'missing-provider', dependency: 'nothing', key: 'nothing' }] })
  })
})
