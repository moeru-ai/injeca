import { describe, expect, it, vi } from 'vitest'

import { BuildAfterDisposeError, DuplicateServiceError, StaleRegistrationError, TransactionIncompleteError } from '../diagnostics/errors'
import { defineKey, dispose, graph, provide, start, transaction } from '../scoped'
import { collectRecords, createTestContainer, deferred, drained, phaseOf, stateOf } from '../testing/helpers'

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
    expect(graph(app).services()).toEqual([expect.objectContaining({ key: 'kit.status', phase: 'declared' }), expect.objectContaining({ key: 'airi.character', phase: 'declared' })])
    expect(stateOf(app, statusKitKey).phase).toBeUndefined()

    await tx.commit()
    await drained(app)
    expect(events).toEqual(['build character', 'build status (character)', 'start character', 'start status'])
    expect(phaseOf(app, statusKitKey)).toBe('running')

    // Both services go to `starting` in one batch, before any of them runs.
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
    expect(graph(app).services()).toEqual([])
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

  it('sends a service without available dependencies to pending at the commit. That is not a failure', async () => {
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

  it('fails with transaction-incomplete for a declared service without provide, unless the declaration is optional', async () => {
    const app = createTestContainer()
    const tx = transaction(app)
    tx.declare(statusKitKey)
    tx.declare('kit.optional', { optional: true })
    await expect(tx.commit()).rejects.toBeInstanceOf(TransactionIncompleteError)

    const second = transaction(app)
    second.declare('kit.optional', { optional: true })
    second.provide(statusKitKey, () => 'status')
    await second.commit()
    expect(graph(app).services().map(service => service.key)).toEqual(['kit.status'])
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
    await expect(duplicate.commit()).rejects.toBeInstanceOf(DuplicateServiceError)
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

  it('replaces a running service at the commit without a gap, and fails for a key without a registration', async () => {
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

  it('publishes the services of a container that is not started as pending', async () => {
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
