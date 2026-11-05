import { describe, expect, it } from 'vitest'

import { graph, invoke, start } from '../scoped'
import { createTestContainer, drained } from '../testing/helpers'

describe('invoke handle (G12)', () => {
  it('has a key that graph queries accept', async () => {
    const app = createTestContainer()
    const handle = invoke(app, { dependsOn: { llm: 'airi.llm' }, callback: () => {} })
    void start(app)
    await drained(app)

    expect(handle.key).toMatch(/^invocation:/)
    expect(graph(app).dependencies(handle.key)).toEqual([expect.objectContaining({ name: 'llm', resolution: 'missing' })])
    expect(graph(app).explain(handle.key)).toMatchObject({ kind: 'invocation', phase: 'pending', blockers: [{ kind: 'missing-provider', key: 'airi.llm' }] })
    await expect(handle.withdraw()).resolves.toBe(true)
  })
})
