import { describe, expect, it, vi } from 'vitest'

import { InvalidArgumentError } from '../diagnostics/errors'
import { dispose, listen, listeners } from '../scoped'
import { createTestContainer } from '../testing/helpers'

const gateKey = { id: 'airi.harness.gate' }

describe('listener registry', () => {
  it('stores listeners with their owner and metadata, in registration order, across child containers', () => {
    const root = createTestContainer({ owner: { kind: 'host' } })
    const plugin = createTestContainer({ parent: root, owner: { kind: 'plugin', id: 'a' } })
    const first = vi.fn()
    const second = vi.fn()
    listen(plugin, gateKey, first, { priority: 10 })
    listen(root, gateKey, second)
    listen(root, { id: 'other' }, vi.fn())

    const entries = listeners<typeof first>(root, { id: 'airi.harness.gate' })
    expect(entries).toEqual([
      { handler: first, owner: { kind: 'plugin', id: 'a' }, metadata: { priority: 10 } },
      { handler: second, owner: { kind: 'host' }, metadata: {} },
    ])
    expect(Object.isFrozen(entries[0]!.metadata)).toBe(true)
    expect(listeners(plugin, gateKey)).toHaveLength(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('removes a listener with its disposer and with the disposal of its container', async () => {
    const root = createTestContainer()
    const plugin = createTestContainer({ parent: root })
    const stop = listen(root, gateKey, () => {})
    listen(plugin, gateKey, () => {})
    expect(listeners(root, gateKey)).toHaveLength(2)

    stop()
    stop()
    expect(listeners(root, gateKey)).toHaveLength(1)
    await dispose(plugin)
    expect(listeners(root, gateKey)).toEqual([])
  })

  it('rejects an event key without a string id and a handler that is not a function', () => {
    const root = createTestContainer()
    expect(() => listen(root, { id: '' }, () => {})).toThrow(InvalidArgumentError)
    // @ts-expect-error A handler must be a function.
    expect(() => listen(root, gateKey, 'nope')).toThrow(InvalidArgumentError)
  })
})
