import type { InferProvided, ProvidedBy } from './scoped'

import { sleep } from '@moeru/std/sleep'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  createContainer,
  normalizeName,
  normalizeProvideOption,
  provide,
  resolve,
} from './scoped'

describe('normalizeName', () => {
  it('should normalize names correctly', () => {
    expect(normalizeName('simpleName')).toBe('simpleName')
    expect(normalizeName({ key: 'objectName' })).toBe('objectName')
  })
})

describe('normalizeProvideOption', () => {
  it('should normalize provide options correctly', () => {
    expect(() => normalizeProvideOption('simpleName')).toThrowError('When using provide(...) as named callback, the second argument must be either a valid ProvideOptionObject<T, D> or a ProvideOptionFunc<T, D>.')
    expect(() => normalizeProvideOption({ key: 'objectName' })).toThrowError('When using provide(...) as typed ProvideOptionWithKeys<T, D, Key> callback, the second argument must be either a valid ProvideOptionObject<T, D> or a ProvideOptionFunc<T, D>.')

    const namedOption = normalizeProvideOption('name', () => {})
    expect(namedOption).toBeTypeOf('object')
    expect(namedOption).toHaveProperty('build')
    expect(() => namedOption.build({} as any)).not.toThrow()

    const typedOption = normalizeProvideOption({ key: 'name' }, () => {})
    expect(typedOption).toBeTypeOf('object')
    expect(typedOption).toHaveProperty('build')
    expect(() => typedOption.build({} as any)).not.toThrow()

    const autoNameOption = normalizeProvideOption(() => {})
    expect(autoNameOption).toBeTypeOf('object')
    expect(autoNameOption).toHaveProperty('build')
    expect(() => autoNameOption.build({} as any)).not.toThrow()
  })
})

describe('resolve', () => {
  it('should allow forced types for string dependency keys', async () => {
    interface Database {
      url: string
    }

    const app = createContainer()
    provide(app, 'db', () => ({ url: 'memory://' } as Database))

    const resolved = await resolve(app, { database: 'db' as ProvidedBy<Database> })

    expectTypeOf(resolved.database).toMatchTypeOf<Database>()
    expect(resolved.database.url).toBe('memory://')
  })

  it('should infer provided types from ProvidedKey and AsProvidedOf', () => {
    interface Database {
      url: string
    }

    const app = createContainer()
    // eslint-disable-next-line unused-imports/no-unused-vars
    const database = provide(app, 'db', () => ({ url: 'memory://' } as Database))

    expectTypeOf<InferProvided<typeof database>>().toEqualTypeOf<Database>()
    expectTypeOf<InferProvided<ProvidedBy<Database>>>().toEqualTypeOf<Database>()
  })

  it('should reuse in-progress builds to avoid duplicate construction', async () => {
    const app = createContainer()

    const buildSpy = vi.fn().mockImplementation(async () => {
      await sleep(250)
      return { createdAt: Date.now() }
    })

    const unit = provide(app, 'unit', buildSpy)

    const [first, second] = await Promise.all([
      resolve(app, { unit }),
      resolve(app, { unit }),
    ])

    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(first.unit).toBe(second.unit)
  })

  it('should reuse resolved results', async () => {
    const app = createContainer()

    let databaseCreatedAt: number | undefined

    const databaseBuildSpy = vi.fn().mockImplementation(async () => {
      await sleep(100)
      databaseCreatedAt = Date.now()
      return { name: 'database', createdAt: databaseCreatedAt }
    })
    const database = provide(app, 'database', databaseBuildSpy)

    const model1BuildSpy = vi.fn().mockImplementation(async ({ dependsOn }) => {
      await sleep(100)
      return { name: 'model1', dbName: dependsOn.database.name, dbCreatedAt: dependsOn.database.createdAt }
    })
    const model1 = provide(app, 'model1', {
      dependsOn: { database },
      build: model1BuildSpy,
    })

    const model2BuildSpy = vi.fn().mockImplementation(async ({ dependsOn }) => {
      await sleep(100)
      return { name: 'model2', dbName: dependsOn.database.name, dbCreatedAt: dependsOn.database.createdAt }
    })
    const model2 = provide(app, 'model2', {
      dependsOn: { database },
      build: model2BuildSpy,
    })

    const handler = provide(app, 'handler', {
      dependsOn: { model1, model2 },
      build: async ({ dependsOn }) => {
        return {
          model1: dependsOn.model1,
          model2: dependsOn.model2,
        }
      },
    })

    const resolved = await resolve(app, { handler })

    expect(resolved.handler.model1.dbName).toBe('database')
    expect(resolved.handler.model2.dbName).toBe('database')
    expect(resolved.handler.model1.dbCreatedAt).toBe(databaseCreatedAt)
    expect(resolved.handler.model2.dbCreatedAt).toBe(databaseCreatedAt)
    expect(resolved.handler).toBe(await resolve(app, { handler }).then(r => r.handler))

    expect(databaseBuildSpy).toHaveBeenCalledTimes(1)
    expect(model1BuildSpy).toHaveBeenCalledTimes(1)
    expect(model2BuildSpy).toHaveBeenCalledTimes(1)
  })
})
