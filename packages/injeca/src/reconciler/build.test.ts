import { describe, expect, it, vi } from 'vitest'

import { defineKey, invoke, optional, provide, start } from '../scoped'
import { createTestContainer, deferred, drained, stateOf } from '../testing/helpers'

describe('serial transitions', () => {
  // Design test 5.
  it('discards a build whose required dependency gets a new instance during the build, then builds with the new one', async () => {
    const root = createTestContainer()
    const child = createTestContainer({ parent: root })
    const firstBuild = deferred<string>()
    const seen: string[] = []
    const startHook = vi.fn()
    let signal: AbortSignal | undefined

    provide(root, 'airi.llm', () => 'root llm')
    provide(child, 'voice.speech', {
      dependsOn: { llm: 'airi.llm' },
      build: (context) => {
        seen.push(context.dependsOn.llm as string)
        if (seen.length === 1) {
          signal = context.signal
          context.on('start', startHook)
          return firstBuild.promise
        }
        return 'speech'
      },
    })
    await start(root)
    void start(child)
    await drained(root)
    expect(stateOf(child, 'voice.speech').phase).toBe('building')

    // A provider in the child container shadows the root provider.
    provide(child, 'airi.llm', () => 'child llm')
    await drained(root)
    expect(signal?.aborted).toBe(true)

    firstBuild.resolve('late')
    await drained(root)
    expect(startHook).not.toHaveBeenCalled()
    expect(seen).toEqual(['root llm', 'child llm'])
    expect(stateOf(child, 'voice.speech').phase).toBe('running')
  })
})

describe('invocations', () => {
  // Design test 33.
  it('runs an invocation again with the new values, and gives each run a hook context', async () => {
    const app = createTestContainer()
    const seen: string[] = []
    const stops: { attempt: number, aborted: boolean }[] = []
    const configKey = defineKey<string>('config')

    const first = provide(app, configKey, () => 'first')
    invoke(app, {
      dependsOn: { config: configKey },
      callback: ({ config }, { on }) => {
        seen.push(config)
        on('stop', ({ attempt, signal, decide }) => {
          stops.push({ attempt, aborted: signal.aborted })
          return decide.handled()
        })
      },
    })
    await start(app)

    await first.withdraw()
    provide(app, configKey, () => 'second')
    await drained(app)

    expect(seen).toEqual(['first', 'second'])
    expect(stops).toEqual([{ attempt: 1, aborted: false }])
  })

  it('lets an invocation handle an optional dependency in place', async () => {
    const app = createTestContainer()
    const runs = vi.fn()
    const values: unknown[] = []
    invoke(app, {
      dependsOn: { tts: optional('airi.tts') },
      callback: (_, { on }) => {
        runs()
        on('dependency-change', ({ dependsOn, decide }) => {
          values.push(dependsOn.tts?.value)
          return decide.handled()
        })
      },
    })
    await start(app)

    provide(app, 'airi.tts', () => 'tts')
    await drained(app)
    expect(runs).toHaveBeenCalledTimes(1)
    expect(values).toEqual(['tts'])
  })
})
