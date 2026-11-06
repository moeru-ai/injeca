import { describe, expect, it, vi } from 'vitest'

import { BuildAfterDisposeError, DuplicateUnitError, StaleRegistrationError, TransactionIncompleteError } from '../diagnostics/errors'
import { defineKey, dispose, graph, provide, start, transaction } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, phaseOf, stateOf, trackedController } from '../testing/helpers'

const characterKey = defineKey<string>('airi.character')
const statusKitKey = defineKey<string>('kit.status')

describe('transactions', () => {
  it('builds in dependency order, publishes in one batch, and runs start hooks only after the publish', async () => {
    const app = createTestContainer()
    await start(app)
    const events: string[] = []
    const { records } = collectRecords(app)
    const tx = transaction(app)

    tx.declare(statusKitKey, { dependsOn: { character: characterKey } })
    // The dependent comes first. The commit builds its dependency of the same transaction first.
    tx.provide(statusKitKey, {
      build: ({ dependsOn, on }) => {
        // The provide has no dependsOn of its own. The edges come from the declaration, so the type does not know them.
        events.push(`build status (${(dependsOn as { character: string }).character})`)
        on('start', () => {
          events.push('start status')
        })
        return 'status'
      },
    })
    tx.provide(characterKey, ({ on }) => {
      events.push('build character')
      on('start', () => {
        events.push('start character')
      })
      return 'character'
    })
    expect(graph(app).units()).toEqual([expect.objectContaining({ key: 'kit.status', phase: 'declared' }), expect.objectContaining({ key: 'airi.character', phase: 'declared' })])
    expect(stateOf(app, statusKitKey).phase).toBeUndefined()

    await tx.commit()
    await drained(app)
    expect(events).toEqual(['build character', 'build status (character)', 'start character', 'start status'])
    expect(phaseOf(app, statusKitKey)).toBe('running')

    // Both units go to `starting` in one batch, before any of them runs.
    const phases = records.flatMap(record => record.type === 'phase' && (record.to === 'starting' || record.to === 'running') ? [`${record.key} ${record.to}`] : [])
    expect(phases.slice(0, 2).sort()).toEqual(['airi.character starting', 'kit.status starting'])
    expect(phases.slice(2)).toEqual(['airi.character running', 'kit.status running'])
  })

  it('publishes nothing and runs no start hook when one build fails (design test 2)', async () => {
    const app = createTestContainer()
    await start(app)
    const startHook = vi.fn()
    const disposer = vi.fn()
    const error = new Error('kit failed')
    const tx = transaction(app)
    const character = tx.provide(characterKey, ({ on, effect }) => {
      on('start', startHook)
      effect(() => disposer)
      return 'character'
    })
    tx.provide(statusKitKey, {
      dependsOn: { character: characterKey },
      build: () => {
        throw error
      },
    })

    await expect(tx.commit()).rejects.toBe(error)
    await drained(app)
    expect(startHook).not.toHaveBeenCalled()
    expect(disposer).toHaveBeenCalledTimes(1)
    expect(stateOf(app, characterKey).phase).toBeUndefined()
    expect(stateOf(app, statusKitKey).phase).toBeUndefined()
    expect(graph(app).units()).toEqual([])
    await expect(character.withdraw()).resolves.toBe(false)
  })

  it('aborts on container disposal during the commit. A late build cannot publish (design test 3)', async () => {
    const app = createTestContainer()
    await start(app)
    const gate = deferred<string>()
    const signals: AbortSignal[] = []
    const startHook = vi.fn()
    const tx = transaction(app)
    tx.provide(characterKey, ({ signal, on }) => {
      signals.push(signal)
      on('start', startHook)
      return gate.promise
    })

    const committed = tx.commit()
    await drained(app)
    expect(phaseOf(app, characterKey)).toBeUndefined()
    const disposed = dispose(app)
    expect(signals[0]?.aborted).toBe(true)

    gate.resolve('late')
    await expect(committed).rejects.toBeInstanceOf(BuildAfterDisposeError)
    await disposed
    expect(startHook).not.toHaveBeenCalled()
  })

  it('aborts on container disposal before the commit', async () => {
    const app = createTestContainer()
    const tx = transaction(app)
    tx.provide(characterKey, () => 'character')
    await dispose(app)
    await expect(tx.commit()).rejects.toThrow()
  })

  it('sends a unit without available dependencies to pending at the commit. That is not a failure', async () => {
    const app = createTestContainer()
    await start(app)
    const tx = transaction(app)
    tx.provide(statusKitKey, { dependsOn: { character: characterKey }, build: ({ dependsOn }) => dependsOn.character })
    await tx.commit()
    expect(phaseOf(app, statusKitKey)).toBe('pending')

    provide(app, characterKey, () => 'character')
    await drained(app)
    expect(phaseOf(app, statusKitKey)).toBe('running')
  })

  it('fails with transaction-incomplete for a declared unit without provide, unless the declaration is optional', async () => {
    const app = createTestContainer()
    const tx = transaction(app)
    tx.declare(statusKitKey)
    tx.declare('kit.optional', { optional: true })
    await expect(tx.commit()).rejects.toBeInstanceOf(TransactionIncompleteError)

    const second = transaction(app)
    second.declare('kit.optional', { optional: true })
    second.provide(statusKitKey, () => 'status')
    await second.commit()
    expect(graph(app).units().map(unit => unit.key)).toEqual(['kit.status'])
  })

  it('removes everything on abort, and fails a duplicate in a started container', async () => {
    const app = createTestContainer()
    await start(app)
    const tx = transaction(app)
    const build = vi.fn(() => 'status')
    tx.provide(statusKitKey, build)
    await tx.abort()
    await expect(tx.commit()).rejects.toThrow()
    expect(build).not.toHaveBeenCalled()

    provide(app, characterKey, () => 'character')
    const duplicate = transaction(app)
    duplicate.provide(characterKey, () => 'again')
    await expect(duplicate.commit()).rejects.toBeInstanceOf(DuplicateUnitError)
  })

  it('aborts with tx.abort() during the commit', async () => {
    const app = createTestContainer()
    await start(app)
    const gate = deferred<string>()
    const tx = transaction(app)
    tx.provide(characterKey, () => gate.promise)
    const committed = tx.commit()
    const aborted = tx.abort()
    gate.resolve('late')
    await expect(committed).rejects.toBeInstanceOf(TransactionIncompleteError)
    await aborted
    expect(stateOf(app, characterKey).phase).toBeUndefined()
  })

  it('replaces a running unit at the commit without a gap, and fails for a key without a registration', async () => {
    const app = createTestContainer()
    const character = provide(app, characterKey, () => 'old')
    const dependent = vi.fn(({ dependsOn }: { dependsOn: { character: string } }) => dependsOn.character)
    provide(app, statusKitKey, { dependsOn: { character }, build: dependent })
    await start(app)
    const oldId = stateOf(app, character).instanceId

    const tx = transaction(app)
    tx.replace(character, () => 'new')
    await tx.commit()
    await drained(app)
    expect(stateOf(app, character).instanceId).not.toBe(oldId)
    expect(dependent).toHaveBeenLastCalledWith(expect.objectContaining({ dependsOn: { character: 'new' } }))
    // The registration stays current after the transaction replaced it.
    await expect(character.replace(() => 'newer')).resolves.toBe(true)

    const stale = transaction(app)
    stale.replace('kit.missing', () => 'x')
    await expect(stale.commit()).rejects.toBeInstanceOf(StaleRegistrationError)
  })

  it('publishes the units of a container that is not started as pending', async () => {
    const app = createTestContainer()
    const build = vi.fn(() => 'character')
    const tx = transaction(app)
    const character = tx.provide(characterKey, build)
    await tx.commit()
    expect(build).not.toHaveBeenCalled()
    expect(phaseOf(app, character)).toBe('pending')

    await start(app)
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('withdraw before the commit (B4)', () => {
  it('removes the provide from the transaction, so the declared key fails the commit', async () => {
    const app = createTestContainer()
    await start(app)
    const build = vi.fn(() => 'status')
    const tx = transaction(app)
    tx.declare(statusKitKey)
    const status = tx.provide(statusKitKey, build)

    await expect(status.withdraw()).resolves.toBe(true)
    await expect(status.withdraw()).resolves.toBe(false)
    await expect(tx.commit()).rejects.toBeInstanceOf(TransactionIncompleteError)
    expect(build).not.toHaveBeenCalled()
    expect(graph(app).units()).toEqual([])
  })

  it('drops a provide without a declaration, and keeps an optional declaration', async () => {
    const app = createTestContainer()
    await start(app)
    const tx = transaction(app)
    tx.declare(statusKitKey, { optional: true })
    const status = tx.provide(statusKitKey, () => 'status')
    const character = tx.provide(characterKey, () => 'character')
    tx.provide('kept', () => 'kept')

    await expect(status.withdraw()).resolves.toBe(true)
    await expect(character.withdraw()).resolves.toBe(true)
    await tx.commit()
    await drained(app)
    expect(graph(app).units().map(unit => `${unit.key}:${unit.phase}`)).toEqual(['kept:running'])
    // The key is free again after the withdrawal.
    provide(app, characterKey, () => 'other')
  })

  it('withdraws the published unit when it is called during the commit', async () => {
    const app = createTestContainer()
    await start(app)
    const gate = deferred()
    const tx = transaction(app)
    const status = tx.provide(statusKitKey, () => gate.promise.then(() => 'status'))
    const committed = tx.commit()
    const withdrawn = status.withdraw()
    gate.resolve()
    await committed

    await expect(withdrawn).resolves.toBe(true)
    await drained(app)
    expect(graph(app).units()).toEqual([])
  })
})

describe('declare reserves the key (G5)', () => {
  it('fails another provide of the key in the same container before the commit or the abort', async () => {
    const app = createTestContainer()
    await start(app)
    const tx = transaction(app)
    tx.declare(statusKitKey)

    expect(() => provide(app, statusKitKey, () => 'other')).toThrow(DuplicateUnitError)
    expect(() => transaction(app).declare(statusKitKey)).toThrow(DuplicateUnitError)
    expect(() => transaction(app).provide(statusKitKey, () => 'other')).toThrow(DuplicateUnitError)

    await tx.abort()
    provide(app, statusKitKey, () => 'other')
    await drained(app)
    expect(phaseOf(app, statusKitKey)).toBe('running')
  })

  it('puts a provider of an exclusive key in another container of the area in conflict until the abort', async () => {
    const kitKey = defineKey<string>('kit.exclusive', { exclusive: true })
    const root = createTestContainer({ owner: { kind: 'host' } })
    const child = createTestContainer({ parent: root, owner: { kind: 'extension' } })
    await start(root)
    await start(child)
    const build = vi.fn(() => 'child kit')
    const tx = transaction(root)
    tx.declare(kitKey)

    provide(child, kitKey, build)
    await drained(root)
    expect(phaseOf(child, kitKey)).toBe('conflict')
    expect(build).not.toHaveBeenCalled()
    expect(graph(child).explain(kitKey)?.blockers).toEqual([{ kind: 'conflict', key: 'kit.exclusive', owners: [{ kind: 'host' }, { kind: 'extension' }] }])

    await tx.abort()
    await drained(root)
    expect(phaseOf(child, kitKey)).toBe('running')
  })

  it('keeps the conflict after the commit, because both declarations are published', async () => {
    const kitKey = defineKey<string>('kit.exclusive', { exclusive: true })
    const root = createTestContainer({ owner: { kind: 'host' } })
    const child = createTestContainer({ parent: root, owner: { kind: 'extension' } })
    await start(root)
    await start(child)
    const tx = transaction(root)
    tx.declare(kitKey)
    tx.provide(kitKey, () => 'root kit')
    provide(child, kitKey, () => 'child kit')

    await tx.commit()
    await drained(root)
    expect(phaseOf(root, kitKey)).toBe('conflict')
    expect(phaseOf(child, kitKey)).toBe('conflict')
  })
})

describe('commit with a signal', () => {
  it('aborts the transaction when the signal aborts during a build, rejects at once, and publishes nothing', async () => {
    const app = createTestContainer()
    await start(app)
    const gate = deferred()
    const signals: AbortSignal[] = []
    const tx = transaction(app)
    tx.provide('airi.llm', async ({ signal }) => {
      signals.push(signal)
      await gate.promise
      return 'llm'
    })
    const controller = new AbortController()
    const reason = new Error('the user cancelled')

    const committed = tx.commit({ signal: controller.signal })
    await drained(app)
    controller.abort(reason)
    await expect(committed).rejects.toBe(reason)
    expect(signals[0]?.reason).toBe(reason)

    // The rollback ends when the build settles. Then the key is free.
    gate.resolve()
    await drained(app)
    expect(graph(app).units()).toEqual([])
    provide(app, 'airi.llm', () => 'other')
    await drained(app)
    expect(phaseOf(app, 'airi.llm')).toBe('running')
  })

  it('rejects at once for an aborted signal and builds nothing', async () => {
    const app = createTestContainer()
    await start(app)
    const build = vi.fn(() => 'llm')
    const tx = transaction(app)
    tx.provide('airi.llm', build)

    await expect(tx.commit({ signal: AbortSignal.abort('closed') })).rejects.toBe('closed')
    await drained(app)
    expect(build).not.toHaveBeenCalled()
    expect(graph(app).units()).toEqual([])
    await expect(tx.commit()).rejects.toThrow('aborted')
  })

  it('has no effect after the publish, and removes its listener', async () => {
    const app = createTestContainer()
    await start(app)
    const tx = transaction(app)
    tx.provide('airi.llm', () => 'llm')
    const { controller, signal, listeners } = trackedController()

    await tx.commit({ signal })
    expect(listeners()).toBe(0)
    controller.abort('late')
    await drained(app)
    expect(phaseOf(app, 'airi.llm')).toBe('running')
  })

  it('rejects a commit with tx.replace with the reason before the publish. The old instance stays', async () => {
    const app = createTestContainer()
    const llm = provide(app, 'airi.llm', () => 'old')
    await start(app)
    const oldId = stateOf(app, llm).instanceId
    const gate = deferred()
    const tx = transaction(app)
    tx.replace(llm, async () => {
      await gate.promise
      return 'new'
    })
    const { controller, signal, listeners } = trackedController()
    const reason = new Error('the user cancelled')

    const committed = tx.commit({ signal })
    await drained(app)
    controller.abort(reason)
    await expect(committed).rejects.toBe(reason)
    expect(listeners()).toBe(0)

    gate.resolve()
    await drained(app)
    expect(stateOf(app, llm)).toMatchObject({ phase: 'running', instanceId: oldId })
    await expect(llm.replace(() => 'newer')).resolves.toBe(true)
  })
})
