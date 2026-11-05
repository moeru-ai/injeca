import { describe, expect, it } from 'vitest'

import { provide, start } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, stateOf } from '../testing/helpers'

describe('serial transitions', () => {
  // Design test 6.
  it('builds the service again after its stop ends when the dependency returns during the stop', async () => {
    const app = createTestContainer()
    const stopGate = deferred()
    const seen: string[] = []

    const llm = provide(app, 'airi.llm', () => 'llm 1')
    provide(app, 'voice.speech', {
      dependsOn: { llm: 'airi.llm' },
      build: ({ dependsOn, on }) => {
        seen.push(dependsOn.llm as string)
        if (seen.length === 1)
          on('stop', () => stopGate.promise)
        return 'speech'
      },
    })
    await start(app)

    const withdrawal = llm.withdraw()
    await drained(app)
    expect(stateOf(app, 'voice.speech').phase).toBe('stopping')

    provide(app, 'airi.llm', () => 'llm 2')
    await drained(app)
    expect(stateOf(app, 'airi.llm').phase).toBe('running')
    expect(seen).toEqual(['llm 1'])

    stopGate.resolve()
    await withdrawal
    await drained(app)
    expect(seen).toEqual(['llm 1', 'llm 2'])
    expect(stateOf(app, 'voice.speech').phase).toBe('running')
  })
})

describe('superseded runs', () => {
  // Design test 11, start part.
  it('ignores and records the decision of a start run that a withdrawal superseded', async () => {
    const app = createTestContainer()
    // The gate holds the start hook of speech, so that the withdrawal supersedes a start run in progress.
    const speechStartGate = deferred()
    const llm = provide(app, 'airi.llm', () => 'llm')
    let runSignal: AbortSignal | undefined
    provide(app, 'voice.speech', {
      dependsOn: { llm },
      build: ({ on }) => {
        on('start', async ({ decide, signal }) => {
          runSignal = signal
          await speechStartGate.promise
          return decide.fail(new Error('late failure'))
        })
        return 'speech'
      },
    })
    void start(app)
    await drained(app)
    const { records } = collectRecords(app)

    const withdrawal = llm.withdraw()
    await drained(app)
    expect(runSignal?.aborted).toBe(true)

    speechStartGate.resolve()
    await withdrawal
    // The fail decision is ignored. The service waits for a provider again. It is not failed.
    expect(stateOf(app, 'voice.speech').phase).toBe('pending')
    expect(records).toContainEqual(expect.objectContaining({ type: 'decision', key: 'voice.speech', hook: 'start', decision: 'fail', ignored: true }))
  })
})
