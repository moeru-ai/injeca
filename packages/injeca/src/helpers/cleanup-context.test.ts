import type { AsyncContext } from '../types'

import { describe, expect, it } from 'vitest'

import { HookTimeoutError, InvalidArgumentError, ReentrantDisposeError } from '../diagnostics/errors'
import { dispose, effect, provide, start } from '../scoped'
import { createTestContainer, manualClock } from '../testing/helpers'

interface AsyncLocalStorageLike {
  run: <T>(store: unknown, fn: () => T) => T
  getStore: () => unknown
}

// The tests run on Node. The Node types stay out of the program, so that a Node global in the library source is a type error.
const { AsyncLocalStorage } = await import('node:async_hooks' as string) as { AsyncLocalStorage: new () => AsyncLocalStorageLike }

/** The async context of a Node caller. A caller writes the same lines with `AsyncLocalStorage`. */
function asyncLocalContext(): AsyncContext {
  const storage = new AsyncLocalStorage()
  return { run: (store, fn) => storage.run(store, fn), get: () => storage.getStore() }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('asyncContext', () => {
  it('rejects a stop hook that awaits the disposal of its own container after an await', async () => {
    const app = createTestContainer({ asyncContext: asyncLocalContext() })
    const reentrant: unknown[] = []
    provide(app, 'airi.session', ({ on }) => {
      on('stop', async () => {
        await tick()
        await dispose(app).catch((error: unknown) => reentrant.push(error))
      })
      return 'session'
    })
    await start(app)

    // Without the async context, this disposal waits forever. With it, the inner call rejects at once.
    await dispose(app)
    expect(reentrant).toHaveLength(1)
    expect(reentrant[0]).toBeInstanceOf(ReentrantDisposeError)
  })

  it('rejects a child container effect that awaits the disposal of an ancestor after an await', async () => {
    const root = createTestContainer({ asyncContext: asyncLocalContext() })
    const child = createTestContainer({ parent: root })
    const reentrant: unknown[] = []
    effect(child, () => async () => {
      await tick()
      await dispose(root).catch((error: unknown) => reentrant.push(error))
    })

    await dispose(root)
    expect(reentrant).toHaveLength(1)
    expect(reentrant[0]).toMatchObject({ code: 'reentrant-dispose' })
  })

  it('lets a cleanup dispose another container after an await', async () => {
    const root = createTestContainer({ asyncContext: asyncLocalContext() })
    const a = createTestContainer({ parent: root })
    const b = createTestContainer({ parent: root })
    let disposedB = false
    effect(b, () => () => {
      disposedB = true
    })
    effect(a, () => async () => {
      await tick()
      await dispose(b)
    })

    await dispose(a)
    expect(disposedB).toBe(true)
  })

  it('gives an outside caller the same promise during the disposal', async () => {
    const app = createTestContainer({ asyncContext: asyncLocalContext() })
    let release!: () => void
    effect(app, () => () => new Promise<void>((resolve) => {
      release = resolve
    }))

    const first = dispose(app)
    await tick()
    const second = dispose(app)
    expect(second).toBe(first)
    release()
    await first
  })

  it('rejects an asyncContext option without run and get functions', () => {
    expect(() => createTestContainer({ asyncContext: { run: () => undefined } as unknown as AsyncContext })).toThrow(InvalidArgumentError)
  })

  it('keeps the synchronous rule without an async context, and a stop timeout ends the wait', async () => {
    const { clock, advance } = manualClock()
    const root = createTestContainer({ clock })
    const app = createTestContainer({ parent: root })
    let inner: Promise<void> | undefined
    provide(app, 'airi.session', {
      timeouts: { stop: 1_000 },
      build: ({ on }) => {
        on('stop', async () => {
          await Promise.resolve()
          inner = dispose(app)
          await inner
        })
        return 'session'
      },
    })
    await start(app)

    const disposal = dispose(app)
    await tick()
    // After an await, the call is not detected. It gets the promise of the disposal in progress.
    expect(inner).toBe(disposal)
    advance(1_000)
    await expect(disposal).rejects.toBeInstanceOf(HookTimeoutError)
  })
})
