import { describe, expect, it, vi } from 'vitest'

import { defineKey, dispose, graph, provide, start } from '../../scoped'
import { createTestContainer, drained, phaseOf } from '../../testing/helpers'

const whiteboardKey = defineKey<string>('dev.airi.whiteboard', { exclusive: true })

function plugins() {
  const root = createTestContainer()
  const a = createTestContainer({ parent: root, owner: { kind: 'plugin', id: 'whiteboard-a' } })
  const b = createTestContainer({ parent: root, owner: { kind: 'plugin', id: 'whiteboard-b' } })
  return { root, a, b }
}

describe('exclusive keys', () => {
  it.each(['root first', 'child first'] as const)('puts both declarations in conflict, with the %s (design test 14)', async (order) => {
    const { root, a } = plugins()
    const rootBuild = vi.fn(() => 'root')
    const childBuild = vi.fn(() => 'child')
    if (order === 'root first') {
      provide(root, whiteboardKey, rootBuild)
      provide(a, whiteboardKey, childBuild)
    }
    else {
      provide(a, whiteboardKey, childBuild)
      provide(root, whiteboardKey, rootBuild)
    }
    provide(root, 'whiteboard.panel', { dependsOn: { board: whiteboardKey }, build: ({ dependsOn }) => dependsOn.board })
    void start(root)
    void start(a)
    await drained(root)

    expect(phaseOf(root, whiteboardKey)).toBe('conflict')
    expect(phaseOf(a, whiteboardKey)).toBe('conflict')
    expect(phaseOf(root, 'whiteboard.panel')).toBe('pending')
    expect(rootBuild).not.toHaveBeenCalled()
    expect(childBuild).not.toHaveBeenCalled()

    const explanation = graph(root).explain(whiteboardKey)
    expect(explanation?.blockers).toContainEqual({ kind: 'conflict', key: 'dev.airi.whiteboard', owners: [{}, { kind: 'plugin', id: 'whiteboard-a' }] })
    expect(graph(root).explain('whiteboard.panel')?.blockers).toContainEqual(expect.objectContaining({ kind: 'conflicting-dependency', dependency: 'board', owners: [{}, { kind: 'plugin', id: 'whiteboard-a' }] }))
  })

  it('leaves conflict when the other declaration is removed, and then converges (design test 15)', async () => {
    const { root, a } = plugins()
    provide(root, whiteboardKey, () => 'root')
    provide(a, whiteboardKey, () => 'child')
    const panelBuild = vi.fn(({ dependsOn }: { dependsOn: { board: string } }) => dependsOn.board)
    provide(root, 'whiteboard.panel', { dependsOn: { board: whiteboardKey }, build: panelBuild })
    void start(root)
    void start(a)
    await drained(root)
    expect(phaseOf(root, whiteboardKey)).toBe('conflict')

    await dispose(a)
    await drained(root)
    expect(phaseOf(root, whiteboardKey)).toBe('running')
    expect(phaseOf(root, 'whiteboard.panel')).toBe('running')
    expect(panelBuild).toHaveBeenCalledWith(expect.objectContaining({ dependsOn: { board: 'root' } }))
  })

  it('stops a running provider when a second declaration appears', async () => {
    const { root, a } = plugins()
    const stopHook = vi.fn()
    provide(root, whiteboardKey, ({ on }) => {
      on('stop', stopHook)
      return 'root'
    })
    await start(root)
    expect(phaseOf(root, whiteboardKey)).toBe('running')

    provide(a, whiteboardKey, () => 'child')
    await drained(root)
    expect(stopHook).toHaveBeenCalledTimes(1)
    expect(phaseOf(root, whiteboardKey)).toBe('conflict')
  })

  it('does not conflict across sibling containers or with a container that isolates the key', async () => {
    const { root, a, b } = plugins()
    const isolated = createTestContainer({ parent: root, isolate: [whiteboardKey] })
    provide(a, whiteboardKey, () => 'a')
    provide(b, whiteboardKey, () => 'b')
    await start(a)
    await start(b)
    expect(phaseOf(a, whiteboardKey)).toBe('running')
    expect(phaseOf(b, whiteboardKey)).toBe('running')

    provide(root, whiteboardKey, () => 'root')
    provide(isolated, whiteboardKey, () => 'local')
    await start(isolated)
    await drained(root)
    // The root declaration shares its area with `a` and `b`, but not with the container that isolates the key.
    expect(phaseOf(root, whiteboardKey)).toBe('conflict')
    expect(phaseOf(a, whiteboardKey)).toBe('conflict')
    expect(phaseOf(isolated, whiteboardKey)).toBe('running')
  })

  it('treats a plain name as a rival of an exclusive key', async () => {
    const { root, a } = plugins()
    provide(root, whiteboardKey, () => 'root')
    provide(a, 'dev.airi.whiteboard', () => 'plain')
    void start(root)
    void start(a)
    await drained(root)
    expect(phaseOf(a, 'dev.airi.whiteboard')).toBe('conflict')
  })
})
