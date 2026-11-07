import { describe, expect, it, vi } from 'vitest'

import { defineKey, graph, provide, start } from '../../scoped'
import { createTestContainer, deferred, drained, phaseOf, stateOf } from '../../testing/helpers'

const ttsKey = defineKey<string>('airi.tts')

describe('shadowing', () => {
  it('keeps the ancestor provider until the child provider runs, and moves back when it stops', async () => {
    const root = createTestContainer()
    const child = createTestContainer({ parent: root })
    const childStart = deferred()
    const values: string[] = []
    const build = vi.fn(() => 'speech')
    provide(root, ttsKey, () => 'root tts')
    provide(child, 'voice.speech', {
      dependsOn: { tts: ttsKey },
      build: ({ dependsOn, on }) => {
        values.push(dependsOn.tts)
        on('dependency-change', ({ dependsOn: current, decide }) => {
          values.push(current.tts.value)
          return decide.handled()
        })
        return build()
      },
    })
    await start(root)
    await start(child)

    const childTts = provide(child, ttsKey, ({ on }) => {
      on('start', () => childStart.promise)
      return 'child tts'
    })
    await drained(root)
    // The child provider is starting. The dependent keeps the root provider and does not stop.
    expect(graph(child).units().find(unit => unit.key === 'airi.tts')?.phase).toBe('starting')
    expect(phaseOf(child, 'voice.speech')).toBe('running')
    // A consumer in the child sees the root provider until the child provider runs.
    expect(stateOf(child, ttsKey).instanceId).toBe(stateOf(root, ttsKey).instanceId)
    expect(values).toEqual(['root tts'])

    childStart.resolve()
    await drained(root)
    expect(values).toEqual(['root tts', 'child tts'])
    expect(stateOf(child, ttsKey).instanceId).not.toBe(stateOf(root, ttsKey).instanceId)

    await childTts.withdraw()
    await drained(root)
    expect(values).toEqual(['root tts', 'child tts', 'root tts'])
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('key isolation', () => {
  it('does not resolve an isolated key from the ancestors', async () => {
    const root = createTestContainer()
    const isolated = createTestContainer({ parent: root, isolate: [ttsKey, 'airi.llm'] })
    provide(root, ttsKey, () => 'root tts')
    provide(root, 'airi.llm', () => 'root llm')
    provide(root, 'airi.config', () => 'config')
    provide(isolated, 'voice.speech', { dependsOn: { tts: ttsKey }, build: ({ dependsOn }) => dependsOn.tts })
    provide(isolated, 'voice.config', { dependsOn: { config: 'airi.config' }, build: ({ dependsOn }) => dependsOn.config })
    await start(root)
    void start(isolated)
    await drained(root)

    expect(phaseOf(isolated, 'voice.speech')).toBe('pending')
    expect(phaseOf(isolated, 'voice.config')).toBe('running')

    provide(isolated, ttsKey, () => 'own tts')
    await drained(root)
    expect(phaseOf(isolated, 'voice.speech')).toBe('running')
  })
})
